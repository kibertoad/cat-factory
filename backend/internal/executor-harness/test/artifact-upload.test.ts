import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_UPLOAD_TOKEN_ENV,
  ARTIFACT_UPLOAD_URL_ENV,
  artifactUploadEnv,
  parseArtifactUpload,
} from '../src/artifact-upload.js'
import { redact } from '../src/redact.js'
import { parseAgentJob } from '../src/job.js'

// The OUTBOUND artifact seam. Its backend half (the `artifactUpload` body field and the
// `/artifacts/ingest` route) shipped with the visual-confirmation work while the harness parsed
// neither, so a UI run's screenshots were dropped with no error anywhere. These pin the three
// things that silence depended on: the field is parsed, it reaches the agent's env under the names
// the capturing prompts already use, and its token is redacted before it can reach a log.

describe('parseArtifactUpload', () => {
  it('accepts a well-formed seam', () => {
    expect(
      parseArtifactUpload({ url: 'https://proxy.example/artifacts/ingest', token: 'ct_1' }),
    ).toEqual({ url: 'https://proxy.example/artifacts/ingest', token: 'ct_1' })
  })

  it('trims the url, so a body with stray whitespace still calls the right endpoint', () => {
    expect(
      parseArtifactUpload({ url: '  https://proxy.example/ingest  ', token: 'ct_1' })?.url,
    ).toBe('https://proxy.example/ingest')
  })

  it('drops the WHOLE seam when either half is unusable', () => {
    // A URL with no token and a token with no URL are both an endpoint nothing can call. Half a
    // seam would have the agent upload into a 401 and report success at capturing.
    expect(parseArtifactUpload({ url: 'https://proxy.example/ingest' })).toBeUndefined()
    expect(parseArtifactUpload({ token: 'ct_1' })).toBeUndefined()
    expect(parseArtifactUpload({ url: '', token: 'ct_1' })).toBeUndefined()
    expect(parseArtifactUpload({ url: 'https://proxy.example/ingest', token: '' })).toBeUndefined()
  })

  it('refuses a non-http(s) transport', () => {
    // Same rule the inbound manifests hold their transport half to: the token rides this URL.
    expect(parseArtifactUpload({ url: 'file:///etc/passwd', token: 'ct_1' })).toBeUndefined()
    expect(parseArtifactUpload({ url: 'ftp://host/ingest', token: 'ct_1' })).toBeUndefined()
    expect(parseArtifactUpload({ url: '/artifacts/ingest', token: 'ct_1' })).toBeUndefined()
  })

  it('is absent for a job that carries none, which is the normal case', () => {
    expect(parseArtifactUpload(undefined)).toBeUndefined()
    expect(parseArtifactUpload(null)).toBeUndefined()
    expect(parseArtifactUpload('nope')).toBeUndefined()
  })
})

describe('artifactUploadEnv', () => {
  it('projects the seam onto the two variables the capturing prompts name', () => {
    const env = artifactUploadEnv({ url: 'https://proxy.example/ingest', token: 'ct_upload_aaa' })
    expect(env).toEqual({
      [ARTIFACT_UPLOAD_URL_ENV]: 'https://proxy.example/ingest',
      [ARTIFACT_UPLOAD_TOKEN_ENV]: 'ct_upload_aaa',
    })
  })

  it('registers the token for redaction before it can reach a log', () => {
    artifactUploadEnv({ url: 'https://proxy.example/ingest', token: 'ct_upload_secret_value' })
    expect(redact('uploading with ct_upload_secret_value')).toBe('uploading with ***')
  })

  it('returns the env instead of mutating process.env', () => {
    const before = process.env[ARTIFACT_UPLOAD_TOKEN_ENV]
    artifactUploadEnv({ url: 'https://proxy.example/ingest', token: 'ct_upload_bbb' })
    // The native host transport serves every concurrent ambient job from ONE process, so a global
    // would hand one job's ingest credential to a sibling.
    expect(process.env[ARTIFACT_UPLOAD_TOKEN_ENV]).toBe(before)
  })

  it("keeps two concurrent jobs' upload credentials in separate envs", () => {
    const a = artifactUploadEnv({ url: 'https://proxy.example/a', token: 'ct_from_job_a' })
    const b = artifactUploadEnv({ url: 'https://proxy.example/b', token: 'ct_from_job_b' })
    expect(a[ARTIFACT_UPLOAD_TOKEN_ENV]).toBe('ct_from_job_a')
    expect(b[ARTIFACT_UPLOAD_TOKEN_ENV]).toBe('ct_from_job_b')
  })

  it('is empty for a job with no seam, so the variable stays UNSET', () => {
    // The capturing prompts branch on the variable being unset, which is what makes an absent
    // capability visible to the agent rather than an endpoint that fails at upload time.
    expect(artifactUploadEnv(undefined)).toEqual({})
  })
})

describe('parseAgentJob carries the seam through', () => {
  const base = {
    jobId: 'job-1',
    mode: 'explore',
    systemPrompt: 's',
    userPrompt: 'u',
    model: 'm',
    harness: 'pi',
    proxyBaseUrl: 'https://proxy.example/v1',
    sessionToken: 'st_1',
    ghToken: 'gh_1',
    repo: {
      owner: 'o',
      name: 'r',
      baseBranch: 'main',
      cloneUrl: 'https://github.com/o/r.git',
    },
    branch: 'main',
  }

  it('parses a well-formed seam onto the job', () => {
    const job = parseAgentJob({
      ...base,
      artifactUpload: { url: 'https://proxy.example/v1/artifacts/ingest', token: 'st_1' },
    })
    expect(job.artifactUpload).toEqual({
      url: 'https://proxy.example/v1/artifacts/ingest',
      token: 'st_1',
    })
  })

  it('omits an unusable seam rather than failing the job', () => {
    // A malformed seam costs the run its artifacts, not the run itself: the work the agent was
    // dispatched to do is still worth doing, and the backend states the gap.
    const job = parseAgentJob({ ...base, artifactUpload: { url: 'not-a-url', token: 'st_1' } })
    expect(job.artifactUpload).toBeUndefined()
  })
})
