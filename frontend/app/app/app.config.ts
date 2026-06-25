export default defineAppConfig({
  ui: {
    colors: {
      primary: 'indigo',
      neutral: 'slate',
    },
    // Give every overlay the same layered dark palette the agent-run-details
    // reader uses: a deep slate-950 surface so the slate-900 panels/cards inside
    // pop, with slate-800 chrome. Applies to all UModal/USlideover instances so
    // overlays stay consistent without per-instance `:ui` overrides.
    modal: {
      slots: {
        content: 'bg-slate-950 ring-slate-800 divide-slate-800',
        header: 'border-b border-slate-800',
        title: 'text-white',
      },
    },
    slideover: {
      slots: {
        content: 'bg-slate-950 ring-slate-800 divide-slate-800',
        header: 'border-b border-slate-800',
        title: 'text-white',
      },
    },
  },
})
