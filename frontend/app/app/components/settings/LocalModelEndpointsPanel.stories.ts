import type { Meta, StoryObj } from '@storybook/vue3'
import type { LocalModelEndpoint, LocalModelEndpointTestResult } from '@cat-factory/contracts'
import {
  listLocalModelEndpointsContract,
  testLocalModelEndpointContract,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { localModelEndpoint } from '~/stories/providers.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import LocalModelEndpointsPanel from './LocalModelEndpointsPanel.vue'

// The signed-in user's own model runners (Ollama, LM Studio, llama.cpp, vLLM or any
// OpenAI-compatible server): the connected ones, and the form that adds or edits one. Test
// connection asks the runner which models it serves; the user ticks the ones to offer and may
// say whether each reads images. The deployment may refuse a runner URL, and says why in the
// user's language with the backend's own words under it. The window loads the user's runners
// when it opens, so each story answers that read; the test stories click Test on a stored runner.
function endpointsAre(endpoints: LocalModelEndpoint[]) {
  return apiResponse(listLocalModelEndpointsContract, { body: { endpoints } })
}

function testAnswers(result: LocalModelEndpointTestResult) {
  return apiResponse(testLocalModelEndpointContract, { body: result })
}

/**
 * Click Test once the window has loaded the stored runners: the load re-seeds the form when it
 * lands, so a click before it would have its verdict cleared. The stored runner's row is the
 * sign that it has landed.
 */
async function testUrl(storedLabel: string) {
  await screen.findByText(storedLabel)
  await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }))
}

/** A vLLM runner on the local network, which the deployment no longer permits. */
const gpuBox = localModelEndpoint({
  provider: 'vllm',
  label: 'vLLM on the GPU box',
  baseUrl: 'http://10.0.4.20:8000/v1',
  models: [{ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }],
  urlBlockedReason: 'host_not_loopback',
  unreadableModels: true,
})

const meta = {
  title: 'Settings/Components/LocalModelEndpointsPanel',
  component: LocalModelEndpointsPanel,
  decorators: [withSeed(() => useUiStore().openLocalModels())],
  parameters: { api: [endpointsAre([localModelEndpoint()])] },
} satisfies Meta<typeof LocalModelEndpointsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Ollama on this laptop with two models, and the form editing it. */
export const Default: Story = {}

/** No runner connected: the form adds Ollama at its default URL. */
export const Empty: Story = { parameters: { api: [endpointsAre([])] } }

/**
 * A runner whose URL the deployment no longer permits, and part of whose stored model list could
 * not be read: a warning line for each.
 */
export const EndpointWarnings: Story = {
  parameters: {
    api: [endpointsAre([gpuBox])],
  },
}

/**
 * Testing Ollama on this laptop: it answers with three models, all ticked, each with its
 * image-input choice.
 */
export const TestDiscovered: Story = {
  parameters: {
    api: [
      endpointsAre([localModelEndpoint()]),
      testAnswers({
        reachable: true,
        models: ['qwen3-coder:30b', 'gemma3:27b', 'acme-reviewer:latest'],
      }),
    ],
  },
  play: async () => {
    await testUrl('Ollama on this laptop')
    await screen.findByText('Enable models')
  },
}

/** Nothing listens at the laptop's URL: the runner's failure as it came. */
export const TestUnreachable: Story = {
  parameters: {
    api: [
      endpointsAre([localModelEndpoint()]),
      testAnswers({
        reachable: false,
        models: [],
        error: 'connect ECONNREFUSED 127.0.0.1:11434',
      }),
    ],
  },
  play: async () => {
    await testUrl('Ollama on this laptop')
    await screen.findByText('connect ECONNREFUSED 127.0.0.1:11434')
  },
}

/**
 * Testing the GPU box on the local network, which this deployment refuses: the translated
 * reason, with the backend's own words (which name the operator's setting) under it.
 */
export const TestRefused: Story = {
  parameters: {
    api: [
      endpointsAre([gpuBox]),
      testAnswers({
        reachable: false,
        models: [],
        errorReason: 'host_not_loopback',
        error:
          'A local runner must live on this machine (localhost, 127.x.x.x, or [::1]). ' +
          'Private-LAN runner hosts are disabled on this deployment; an operator can allow ' +
          'them with LOCAL_MODELS_ALLOW_LAN=true.',
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await testUrl('vLLM on the GPU box')
    await screen.findByText(/LOCAL_MODELS_ALLOW_LAN=true/)
  },
}
