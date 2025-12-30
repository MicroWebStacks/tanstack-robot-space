import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/model')({
  ssr: false,
  component: ModelRoute,
})

function ModelRoute() {
  return (
    <div className="min-h-[calc(100vh-var(--app-header-height,72px))] overflow-hidden bg-black" />
  )
}

