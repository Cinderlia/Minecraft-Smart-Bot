import { defineTool } from './types.js'
import { listGuideSections } from '../agent/prompt.js'

const category = 'Planning'

export const planningTools = [
  defineTool({
    name: 'select_guide',
    category,
    description:
      'Call this FIRST, before any other tool, to load the guide sections needed for this task. ' +
      `Choose only relevant headings from: ${listGuideSections().join(' | ')}. ` +
      'Pass them comma-separated, e.g. "Building, Survival". They become available from your next step onward.',
    params: {
      sections: {
        type: 'string',
        description: 'Comma-separated guide section headings to load',
        required: true
      }
    },
    async handler() {
      // Intercepted in agent.ts; this return value is a harmless fallback.
      return 'Guide sections selected.'
    }
  })
]