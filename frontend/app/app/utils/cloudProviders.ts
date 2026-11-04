import { cloudProviderSchema } from '@cat-factory/contracts'
import type { CloudProvider } from '~/types/domain'

// Cloud provider labels, shared by the default-provider picker and the audit log. The brand names
// (Cloudflare, AWS, GCP, Azure) are proper nouns kept verbatim in every locale; only `docker` and
// `custom` carry prose, so those resolve through the catalog.
const CLOUD_PROVIDER_LABEL: Record<CloudProvider, (t: (key: string) => string) => string> = {
  cloudflare: () => 'Cloudflare',
  docker: (t) => t('layout.boardSwitcher.providers.docker'),
  aws: () => 'AWS',
  gcp: () => 'GCP',
  azure: () => 'Azure',
  custom: (t) => t('layout.boardSwitcher.providers.custom'),
}

/** The providers in their display order (the contract's). */
export const CLOUD_PROVIDERS: readonly CloudProvider[] = cloudProviderSchema.options

export function isCloudProvider(value: string): value is CloudProvider {
  return Object.hasOwn(CLOUD_PROVIDER_LABEL, value)
}

export function cloudProviderLabel(provider: CloudProvider, t: (key: string) => string): string {
  return CLOUD_PROVIDER_LABEL[provider](t)
}
