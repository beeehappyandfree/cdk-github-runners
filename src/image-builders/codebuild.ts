import * as cdk from 'aws-cdk-lib';
import {
  Annotations,
  aws_codebuild as codebuild,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3_assets as s3_assets,
  aws_sns as sns,
  CustomResource,
  Duration,
  RemovalPolicy,
} from 'aws-cdk-lib';
import { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import { TagMutability, TagStatus } from 'aws-cdk-lib/aws-ecr';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct, IConstruct } from 'constructs';
import { defaultBaseDockerImage } from './aws-image-builder';
import { BuildImageFunction } from './build-image-function';
import { RunnerImageBuilderBase, RunnerImageBuilderProps } from './common';
import { Architecture, Os, RunnerAmi, RunnerImage, RunnerVersion } from '../providers';
import { singletonLambda } from '../utils';


export interface CodeBuildRunnerImageBuilderProps {
  /**
   * The type of compute to use for this build.
   * See the {@link ComputeType} enum for the possible values.
   *
   * @default {@link ComputeType#SMALL}
   */
  readonly computeType?: codebuild.ComputeType;

  /**
   * Build image to use in CodeBuild. This is the image that's going to run the code that builds the runner image.
   *
   * The only action taken in CodeBuild is running `docker build`. You would therefore not need to change this setting often.
   *
   * @default Amazon Linux 2023
   */
  readonly buildImage?: codebuild.IBuildImage;

  /**
   * The number of minutes after which AWS CodeBuild stops the build if it's
   * not complete. For valid values, see the timeoutInMinutes field in the AWS
   * CodeBuild User Guide.
   *
   * @default Duration.hours(1)
   */
  readonly timeout?: Duration;
}

/**
 * @internal
 */
export class CodeBuildRunnerImageBuilder extends RunnerImageBuilderBase {
  private boundDockerImage?: RunnerImage;
  private readonly os: Os;
  private readonly architecture: Architecture;
  private readonly baseImage: string;
  private readonly logRetention: RetentionDays;
  private readonly logRemovalPolicy: RemovalPolicy;
  private readonly vpc: ec2.IVpc | undefined;
  private readonly securityGroups: ec2.ISecurityGroup[] | undefined;
  private readonly buildImage: codebuild.IBuildImage;
  private readonly repository: ecr.Repository;
  private readonly subnetSelection: ec2.SubnetSelection | undefined;
  private readonly timeout: cdk.Duration;
  private readonly computeType: codebuild.ComputeType;
  private readonly rebuildInterval: cdk.Duration;
  private readonly role: iam.Role;

  constructor(scope: Construct, id: string, props?: RunnerImageBuilderProps) {
    super(scope, id, props);

    if (props?.awsImageBuilderOptions) {
      Annotations.of(this).addWarning('awsImageBuilderOptions are ignored when using CodeBuild runner image builder.');
    }

    this.os = props?.os ?? Os.LINUX_UBUNTU;
    this.architecture = props?.architecture ?? Architecture.X86_64;
    this.rebuildInterval = props?.rebuildInterval ?? Duration.days(7);
    this.logRetention = props?.logRetention ?? RetentionDays.ONE_MONTH;
    this.logRemovalPolicy = props?.logRemovalPolicy ?? RemovalPolicy.DESTROY;
    this.vpc = props?.vpc;
    this.securityGroups = props?.securityGroups;
    this.subnetSelection = props?.subnetSelection;
    this.timeout = props?.codeBuildOptions?.timeout ?? Duration.hours(1);
    this.computeType = props?.codeBuildOptions?.computeType ?? ComputeType.SMALL;
    this.baseImage = props?.baseDockerImage ?? defaultBaseDockerImage(this.os);
    this.buildImage = props?.codeBuildOptions?.buildImage ?? this.getDefaultBuildImage();

    // warn against isolated networks
    if (props?.subnetSelection?.subnetType == ec2.SubnetType.PRIVATE_ISOLATED) {
      Annotations.of(this).addWarning('Private isolated subnets cannot pull from public ECR and VPC endpoint is not supported yet. ' +
        'See https://github.com/aws/containers-roadmap/issues/1160');
    }

    // create service role for CodeBuild
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // create repository that only keeps one tag
    this.repository = new ecr.Repository(this, 'Repository', {
      imageScanOnPush: true,
      imageTagMutability: TagMutability.MUTABLE,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteImages: true,
      lifecycleRules: [
        {
          description: 'Remove soci indexes for replaced images',
          tagStatus: TagStatus.TAGGED,
          tagPrefixList: ['sha256-'],
          maxImageCount: 1,
        },
        {
          description: 'Remove untagged images that have been replaced by CodeBuild',
          tagStatus: TagStatus.UNTAGGED,
          maxImageAge: Duration.days(1),
        },
      ],
    });
  }

  bindAmi(): RunnerAmi {
    throw new Error('CodeBuild image builder cannot be used to build AMI');
  }

  bindDockerImage(): RunnerImage {
    if (this.boundDockerImage) {
      return this.boundDockerImage;
    }

    // log group for the image builds
    const logGroup = new logs.LogGroup(
      this,
      'Logs',
      {
        retention: this.logRetention ?? RetentionDays.ONE_MONTH,
        removalPolicy: this.logRemovalPolicy ?? RemovalPolicy.DESTROY,
      },
    );

    // generate buildSpec
    const buildSpec = this.getBuildSpec(this.repository);

    // create CodeBuild project that builds Dockerfile and pushes to repository
    const project = new codebuild.Project(this, 'CodeBuild', {
      description: `Build docker image for self-hosted GitHub runner ${this.node.path} (${this.os.name}/${this.architecture.name})`,
      buildSpec,
      vpc: this.vpc,
      securityGroups: this.securityGroups,
      subnetSelection: this.subnetSelection,
      role: this.role,
      timeout: this.timeout,
      environment: {
        buildImage: this.buildImage,
        computeType: this.computeType,
        privileged: true,
      },
      logging: {
        cloudWatch: {
          logGroup,
        },
      },
    });

    // permissions
    this.repository.grantPullPush(project);

    // call CodeBuild during deployment
    const cr = this.customResource(project, buildSpec.toBuildSpec());

    // rebuild image on a schedule
    this.rebuildImageOnSchedule(project, this.rebuildInterval);

    // return the image
    this.boundDockerImage = {
      imageRepository: this.repository,
      imageTag: 'latest',
      architecture: this.architecture,
      os: this.os,
      logGroup,
      runnerVersion: RunnerVersion.specific('unknown'),
      _dependable: cr.getAttString('Random'),
    };
    return this.boundDockerImage;
  }

  private getDefaultBuildImage(): codebuild.IBuildImage {
    if (this.os.isIn(Os._ALL_LINUX_VERSIONS)) {
      // CodeBuild just runs `docker build` so its OS doesn't really matter
      if (this.architecture.is(Architecture.X86_64)) {
        return codebuild.LinuxBuildImage.AMAZON_LINUX_2_5;
      } else if (this.architecture.is(Architecture.ARM64)) {
        return codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0;
      }
    }
    if (this.os.is(Os.WINDOWS)) {
      throw new Error('CodeBuild cannot be used to build Windows Docker images https://github.com/docker-library/docker/issues/49');
    }

    throw new Error(`Unable to find CodeBuild image for ${this.os.name}/${this.architecture.name}`);
  }

  private getDockerfileGenerationCommands() {
    let commands = [];
    let dockerfile = `FROM ${this.baseImage}\nVOLUME /var/lib/docker\n`;

    for (let i = 0; i < this.components.length; i++) {
      const componentName = this.components[i].name;
      const assetDescriptors = this.components[i].getAssets(this.os, this.architecture);

      for (let j = 0; j < assetDescriptors.length; j++) {
        if (this.os.is(Os.WINDOWS)) {
          throw new Error("Can't add asset as we can't build Windows Docker images on CodeBuild");
        }

        const asset = new s3_assets.Asset(this, `Component ${i} ${componentName} Asset ${j}`, {
          path: assetDescriptors[j].source,
        });

        if (asset.isFile) {
          commands.push(`aws s3 cp ${asset.s3ObjectUrl} asset${i}-${componentName}-${j}`);
        } else if (asset.isZipArchive) {
          commands.push(`aws s3 cp ${asset.s3ObjectUrl} asset${i}-${componentName}-${j}.zip`);
          commands.push(`unzip asset${i}-${componentName}-${j}.zip -d "asset${i}-${componentName}-${j}"`);
        } else {
          throw new Error(`Unknown asset type: ${asset}`);
        }

        dockerfile += `COPY asset${i}-${componentName}-${j} ${assetDescriptors[j].target}\n`;

        asset.grantRead(this);
      }

      const componentCommands = this.components[i].getCommands(this.os, this.architecture);
      const script = '#!/bin/bash\nset -exuo pipefail\n' + componentCommands.join('\n');
      commands.push(`cat > component${i}-${componentName}.sh <<'EOFGITHUBRUNNERSDOCKERFILE'\n${script}\nEOFGITHUBRUNNERSDOCKERFILE`);
      commands.push(`chmod +x component${i}-${componentName}.sh`);
      dockerfile += `COPY component${i}-${componentName}.sh /tmp\n`;
      dockerfile += `RUN /tmp/component${i}-${componentName}.sh\n`;

      dockerfile += this.components[i].getDockerCommands(this.os, this.architecture).join('\n') + '\n';
    }

    commands.push(`cat > Dockerfile <<'EOFGITHUBRUNNERSDOCKERFILE'\n${dockerfile}\nEOFGITHUBRUNNERSDOCKERFILE`);

    return commands;
  }

  private getBuildSpec(repository: ecr.Repository): codebuild.BuildSpec {
    const thisStack = cdk.Stack.of(this);

    let archUrl;
    if (this.architecture.is(Architecture.X86_64)) {
      archUrl = 'x86_64';
    } else if (this.architecture.is(Architecture.ARM64)) {
      archUrl = 'arm64';
    } else {
      throw new Error(`Unsupported architecture for required CodeBuild: ${this.architecture.name}`);
    }

    return codebuild.BuildSpec.fromObject({
      version: '0.2',
      env: {
        variables: {
          REPO_ARN: repository.repositoryArn,
          REPO_URI: repository.repositoryUri,
          STACK_ID: 'unspecified',
          REQUEST_ID: 'unspecified',
          LOGICAL_RESOURCE_ID: 'unspecified',
          RESPONSE_URL: 'unspecified',
          BASH_ENV: 'codebuild-log.sh',
        },
        shell: 'bash',
      },
      phases: {
        pre_build: {
          commands: [
            'echo "exec > >(tee -a /tmp/codebuild.log) 2>&1" > codebuild-log.sh',
            `aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin ${thisStack.account}.dkr.ecr.${thisStack.region}.amazonaws.com`,
          ],
        },
        build: {
          commands: this.getDockerfileGenerationCommands().concat(
            'docker build --progress plain . -t "$REPO_URI"',
            'docker push "$REPO_URI"',
          ),
        },
        post_build: {
          commands: [
            'rm -f codebuild-log.sh && STATUS="SUCCESS"',
            'if [ $CODEBUILD_BUILD_SUCCEEDING -ne 1 ]; then STATUS="FAILED"; fi',
            'cat <<EOF > /tmp/payload.json\n' +
              '{\n' +
              '  "StackId": "$STACK_ID",\n' +
              '  "RequestId": "$REQUEST_ID",\n' +
              '  "LogicalResourceId": "$LOGICAL_RESOURCE_ID",\n' +
              '  "PhysicalResourceId": "$REPO_ARN",\n' +
              '  "Status": "$STATUS",\n' +
              // we remove non-printable characters from the log because CloudFormation doesn't like them
              // https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/1601
              '  "Reason": `sed \'s/[^[:print:]]//g\' /tmp/codebuild.log | tail -c 400 | jq -Rsa .`,\n' +
              // for lambda always get a new value because there is always a new image hash
              '  "Data": {"Random": "$RANDOM"}\n' +
              '}\n' +
              'EOF',
            'if [ "$RESPONSE_URL" != "unspecified" ]; then jq . /tmp/payload.json; curl -fsSL -X PUT -H "Content-Type:" -d "@/tmp/payload.json" "$RESPONSE_URL"; fi',
            // generate and push soci index
            // we do this after finishing the build, so we don't have to wait. it's also not required, so it's ok if it fails
            'docker rmi "$REPO_URI"', // it downloads the image again to /tmp, so save on space
            'LATEST_SOCI_VERSION=`curl -w "%{redirect_url}" -fsS https://github.com/CloudSnorkel/standalone-soci-indexer/releases/latest | grep -oE "[^/]+$"`',
            `curl -fsSL https://github.com/CloudSnorkel/standalone-soci-indexer/releases/download/$\{LATEST_SOCI_VERSION}/standalone-soci-indexer_Linux_${archUrl}.tar.gz | tar xz`,
            './standalone-soci-indexer "$REPO_URI"',
          ],
        },
      },
    });
  }

  private customResource(project: codebuild.Project, buildSpec: string) {
    const crHandler = singletonLambda(BuildImageFunction, this, 'build-image', {
      description: 'Custom resource handler that triggers CodeBuild to build runner images, and cleans-up images on deletion',
      timeout: cdk.Duration.minutes(3),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const policy = new iam.Policy(this, 'CR Policy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['codebuild:StartBuild'],
          resources: [project.projectArn],
        }),
      ],
    });
    crHandler.role!.attachInlinePolicy(policy);

    const cr = new CustomResource(this, 'Builder', {
      serviceToken: crHandler.functionArn,
      resourceType: 'Custom::ImageBuilder',
      properties: {
        RepoName: this.repository.repositoryName,
        ProjectName: project.projectName,
        // We include the full buildSpec so the image is built immediately on changes, and we don't have to wait for its scheduled build.
        // This also helps make sure the changes are good. If they have a bug, the deployment will fail instead of just the scheduled build.
        BuildSpec: buildSpec,
      },
    });

    // add dependencies to make sure resources are there when we need them
    cr.node.addDependency(project);
    cr.node.addDependency(this.role);
    cr.node.addDependency(policy);
    cr.node.addDependency(crHandler.role!);
    cr.node.addDependency(crHandler);

    return cr;
  }

  private rebuildImageOnSchedule(project: codebuild.Project, rebuildInterval?: Duration) {
    rebuildInterval = rebuildInterval ?? Duration.days(7);
    if (rebuildInterval.toMilliseconds() != 0) {
      const scheduleRule = new events.Rule(this, 'Build Schedule', {
        description: `Rebuild runner image for ${this.repository.repositoryName}`,
        schedule: events.Schedule.rate(rebuildInterval),
      });
      scheduleRule.addTarget(new events_targets.CodeBuildProject(project));
    }
  }

  get connections(): ec2.Connections {
    return new ec2.Connections({
      securityGroups: this.securityGroups,
    });
  }

  get grantPrincipal(): iam.IPrincipal {
    return this.role;
  }
}

/**
 * @internal
 */
export class CodeBuildImageBuilderFailedBuildNotifier implements cdk.IAspect {
  constructor(private topic: sns.ITopic) {
  }

  public visit(node: IConstruct): void {
    if (node instanceof CodeBuildRunnerImageBuilder) {
      const builder = node as CodeBuildRunnerImageBuilder;
      const projectNode = builder.node.tryFindChild('CodeBuild');
      if (projectNode) {
        const project = projectNode as codebuild.Project;
        project.notifyOnBuildFailed('BuildFailed', this.topic);
      } else {
        cdk.Annotations.of(builder).addWarning('Unused builder cannot get notifications of failed builds');
      }
    }
  }
}
