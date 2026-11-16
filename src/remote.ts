import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { z as ZodNamespace } from 'zod'
import type {
  ExternalCliApprovalPolicy,
  ExternalCliHealth,
  ExternalCliModelInfo,
  ExternalCliSandboxMode,
} from './external-cli-contract.js'

export interface CodexPortalStoredSettings {
  binaryPath?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  defaultSandboxMode: ExternalCliSandboxMode
  defaultApprovalPolicy: ExternalCliApprovalPolicy
}

export interface CodexPortalStatusSnapshot {
  health: ExternalCliHealth
  models: ExternalCliModelInfo[]
  config: CodexPortalStoredSettings
}

export interface CodexPortalSessionInfo {
  sessionId: string
  isCodexSession: boolean
  presetId?: string
  threadId?: string
  model?: string
  reasoningEffort?: string
  sandboxMode: ExternalCliSandboxMode
  approvalPolicy: ExternalCliApprovalPolicy
  busy: boolean
}

export interface CodexPortalSelectModelParams {
  sessionId: string
  model: string
  reasoningEffort?: string
}

export interface CodexPortalSessionConfigParams {
  sessionId: string
  sandboxMode?: ExternalCliSandboxMode
  approvalPolicy?: ExternalCliApprovalPolicy
}

export function createCodexPortalRemoteInfo(z: typeof ZodNamespace) {
  const sandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
  const approvalSchema = z.enum(['untrusted', 'on-request', 'auto-review', 'never'])

  const healthSchema = z.object({
    available: z.boolean(),
    binaryPath: z.string().optional(),
    version: z.string().optional(),
    authenticated: z.boolean(),
    accountLabel: z.string().optional(),
    errorCode: z.enum(['CLI_NOT_FOUND', 'CLI_NOT_AUTHENTICATED', 'CLI_UNHEALTHY']).optional(),
    message: z.string().optional(),
  })

  const modelSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    reasoningEfforts: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
    })).optional(),
    defaultReasoningEffort: z.string().optional(),
  })

  const configSchema = z.object({
    binaryPath: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultReasoningEffort: z.string().optional(),
    defaultSandboxMode: sandboxSchema,
    defaultApprovalPolicy: approvalSchema,
  })

  const snapshotSchema = z.object({
    health: healthSchema,
    models: z.array(modelSchema),
    config: configSchema,
  })

  const sessionInfoSchema = z.object({
    sessionId: z.string(),
    isCodexSession: z.boolean(),
    presetId: z.string().optional(),
    threadId: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    sandboxMode: sandboxSchema,
    approvalPolicy: approvalSchema,
    busy: z.boolean(),
  })

  const strictSchema = <T extends ZodNamespace.ZodType>(
    typeSymbol: string,
    create: () => T,
    jsonSchema: Record<string, unknown>,
  ) => ({
    mode: 'strict' as const,
    typeSymbol,
    create,
    jsonSchema,
  })

  const param = <T extends ZodNamespace.ZodType>(
    name: string,
    description: string,
    typeSymbol: string,
    create: () => T,
    jsonSchema: Record<string, unknown>,
  ) => {
    const codec = strictSchema(typeSymbol, create, jsonSchema)
    return {
      name,
      description,
      source: 'json' as const,
      codec,
      strictCodec: codec,
    }
  }

  return createTypertRemoteInfo({
    package: 'dsh-codex-portal',
    methods: {
      'codexPortal/status': {
        service: 'codexPortal',
        description: 'Read current Codex Portal health, model catalog, and settings.',
        implementation: 'remoteStatus',
        invocation: { kind: 'direct' },
        parameters: [],
        result: strictSchema('dsh-codex-portal#CodexPortalStatusSnapshot', () => snapshotSchema, { type: 'object' }),
      },
      'codexPortal/checkHealth': {
        service: 'codexPortal',
        description: 'Force re-probe local Codex CLI binary, login status, and models.',
        implementation: 'remoteCheckHealth',
        invocation: { kind: 'direct' },
        parameters: [],
        result: strictSchema('dsh-codex-portal#CodexPortalStatusSnapshot', () => snapshotSchema, { type: 'object' }),
      },
      'codexPortal/watch': {
        service: 'codexPortal',
        description: 'Stream Codex Portal health/model/config updates.',
        implementation: 'remoteWatch',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [],
        cancellation: { parameter: 'signal' },
        result: strictSchema('dsh-codex-portal#CodexPortalStatusSnapshot', () => snapshotSchema, { type: 'object' }),
      },
      'codexPortal/setConfig': {
        service: 'codexPortal',
        description: 'Update and persist Codex Portal plugin settings.',
        implementation: 'remoteSetConfig',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Updated Codex Portal settings',
            'dsh-codex-portal#CodexPortalConfigPatch',
            () => configSchema.partial(),
            { type: 'object' },
          ),
        ],
        result: strictSchema('dsh-codex-portal#CodexPortalStatusSnapshot', () => snapshotSchema, { type: 'object' }),
      },
      'codexPortal/sessionInfo': {
        service: 'codexPortal',
        description: 'Inspect Codex Portal mode/model state for a session.',
        implementation: 'remoteSessionInfo',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'sessionId',
            'Session id',
            'dsh-codex-portal#SessionIdParam',
            () => z.string().min(1),
            { type: 'string' },
          ),
        ],
        result: strictSchema('dsh-codex-portal#CodexPortalSessionInfo', () => sessionInfoSchema, { type: 'object' }),
      },
      'codexPortal/selectModel': {
        service: 'codexPortal',
        description: 'Select model and reasoning effort for a Codex Portal session.',
        implementation: 'remoteSelectModel',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Model and reasoning effort selection',
            'dsh-codex-portal#CodexPortalSelectModelParams',
            () => z.object({
              sessionId: z.string().min(1),
              model: z.string().min(1),
              reasoningEffort: z.string().optional(),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema('dsh-codex-portal#CodexPortalSessionInfo', () => sessionInfoSchema, { type: 'object' }),
      },
      'codexPortal/setSessionConfig': {
        service: 'codexPortal',
        description: 'Update sandbox mode or approval policy for a Codex Portal session.',
        implementation: 'remoteSetSessionConfig',
        invocation: { kind: 'direct' },
        parameters: [
          param(
            'input',
            'Session sandbox/approval update',
            'dsh-codex-portal#CodexPortalSessionConfigParams',
            () => z.object({
              sessionId: z.string().min(1),
              sandboxMode: sandboxSchema.optional(),
              approvalPolicy: approvalSchema.optional(),
            }),
            { type: 'object' },
          ),
        ],
        result: strictSchema('dsh-codex-portal#CodexPortalSessionInfo', () => sessionInfoSchema, { type: 'object' }),
      },
    },
  } as never, z as never)
}
