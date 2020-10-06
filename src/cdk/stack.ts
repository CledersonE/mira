import * as cdk from '@aws-cdk/core'
import * as aws from 'aws-sdk'
import { NestedStack } from '@aws-cdk/aws-cloudformation'
import { CfnOutput, Construct, Aspects, Tags } from '@aws-cdk/core'
import { IStringParameter, StringParameter } from '@aws-cdk/aws-ssm'
import { Policies } from './aspects/security/policies'
import { MiraConfig, Account } from '../config/mira-config'
import { MiraApp } from './app'
import { MiraObject } from './object'

interface ParsedName {
  readonly id: string
  readonly parameterName: string
}

interface LooseObject {
  /* eslint-disable-next-line */
  [key: string]: any
}

export interface ExportOutputs {
  addOutput (name: string, value: string, shouldExport: boolean): void
}

interface MiraStackProps {
  disablePolicies?: boolean
  approvedWildcardActions?: string[]
  [x: string]: unknown
}

export class MiraStack extends MiraObject {
  static topLevelStacks: LooseObject
  parent?: MiraStack
  stack: cdk.Stack
  props: MiraStackProps
  constructor (name?: string, parent?: MiraStack) {
    if (!name) {
      name = 'DefaultStack'
      console.warn('No stack name provided, prefer a named stack.  Defaulting ' +
        'to name \'DefaultStack\'')
    }
    super(name, 'stack')
    this.parent = parent
  }

  /**
   * Adds an output to the stack.
   * @param name
   * @param value
   * @param shouldExport
   */
  addOutput (name: string, value: string, shouldExport = true): void {
    const exportName = name
    new CfnOutput((this as unknown) as Construct, name, {
      value: value
    })

    if (shouldExport && this.parent && this.parent.stack) {
      new CfnOutput(this.parent.stack, exportName, {
        value: value
      })
    }
  }

  /**
   * Adds tags to the stack.
   */
  async addTags (): Promise<void> {
    const createdBy = await this.getUser()

    Tags.of(this.stack).add('StackName', this.getResourceName())
    Tags.of(this.stack).add('CreatedBy', createdBy)

    const costCenter = MiraConfig.getCostCenter()

    if (costCenter) {
      Tags.of(this.stack).add('CostCenter', costCenter)
    }
  }

  /**
   * Applies security policies.
   */
  applyPolicies (customList?: string[]): void {
    Aspects.of(this.stack).add(new Policies(customList))
  }

  /**
   * Creates a parameter that will reside on the stack in Cfn.
   */
  createParameter (fullName: string, description: string, value: string): StringParameter {
    const { id, parameterName } = this.parseParameterName(fullName)

    return new StringParameter(this.stack, id, {
      description,
      parameterName,
      stringValue: value
    })
  }

  /**
   * Get a username either from the IAM service or from STS.
   */
  async getUser (): Promise<string> {
    const iam = new aws.IAM()
    let owner
    let createdBy: string
    try {
      owner = await iam.getUser().promise()
      createdBy = owner.User.UserName
    } catch (e) {
      const sts = new aws.STS()
      owner = await sts.getCallerIdentity().promise()
      // this is only needed because of Typescript since we use the getCallerIdentity call only when the iam.getUser call fails
      // and that only happens when an assumed role is used instead of an actual user profile
      // in this case the UserId property will be there and the actual userId will be used since it is not possible to get the actual user name
      createdBy = owner.UserId ? owner.UserId.split(':')[0] : 'usr'
    }
    return createdBy
  }

  async initialize (): Promise<void> {
    const account: Account = this.getEnv().env
    if (this.parent) {
      this.stack = new NestedStack(this.parent.stack, this.getResourceName())
    } else {
      this.stack = new cdk.Stack(MiraApp.instance.cdkApp, this.getResourceName(), {
        env: {
          region: account.env.region,
          account: account.env.account
        }
      })
      await this.addTags()
    }
  }

  /**
   * Loads a parameter from attributes.
   */
  loadParameter (fullName: string): IStringParameter {
    const { id, parameterName } = this.parseParameterName(fullName)
    return StringParameter.fromStringParameterAttributes(this.stack, id, {
      parameterName
    })
  }

  /**
 * Parses a parameter given a fully qualified parameter path.
 */
  private parseParameterName (fullName: string): ParsedName {
    const nameParts = fullName.split('/')
    const baseName = nameParts.length === 1 ? this.name : nameParts[0]
    const name = nameParts.length === 1 ? nameParts[0] : nameParts[1]

    const id = `${baseName}${name}Parameter`
    const parameterName = `/${this.getResourceName()}/${baseName}/${name}`

    return { id, parameterName }
  }
}
