import type { Meta, StoryObj } from '@storybook/vue3'
import ConnectionStatusBanner from './ConnectionStatusBanner.vue'

// The pill shown when the board's live stream is not delivering events. Two of the prop
// combinations draw something:
//
//   reconnecting = everConnected && !connected, after a 1.5s debounce
//   offline      = connectionFailed && !connected && !everConnected, at once
//
// Every other combination renders nothing, so there is no story for it. `Reconnecting` appears
// 1.5s after mount: a check that samples sooner sees an empty canvas.
const meta = {
  title: 'Shell/Components/ConnectionStatusBanner',
  component: ConnectionStatusBanner,
} satisfies Meta<typeof ConnectionStatusBanner>
export default meta

type Story = StoryObj<typeof meta>

/** Was connected and lost it. */
export const Reconnecting: Story = {
  args: { connected: false, everConnected: true, connectionFailed: false },
}

/** Never connected, and the first handshake keeps failing. */
export const Offline: Story = {
  args: { connected: false, everConnected: false, connectionFailed: true },
}
