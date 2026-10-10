import type { BadgeProps } from '@nuxt/ui'

/**
 * The colour names a `UBadge` accepts, derived from the component's own prop type rather
 * than restated as a literal union. Nuxt UI resolves the prop from the app config's badge
 * theme, so deriving keeps a chip map honest if the deployment's palette gains or loses a
 * colour, where a hand-written copy would just drift.
 *
 * A status → chip map types its values against this, which is what lets a `:color="…"`
 * binding pass the value straight through. The maps used to be typed `string`, so every
 * binding needed an `as any` to get past the prop's union; that cast also silently accepted
 * a typo'd colour, which renders as an unstyled badge rather than failing the build.
 */
export type BadgeColor = NonNullable<BadgeProps['color']>
