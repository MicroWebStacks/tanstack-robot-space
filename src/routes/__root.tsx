import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { useEffect } from 'react'

import Header from '../components/Header'
import ModelViewerHost from '../components/ModelViewerHost'
import { RobotStatusProvider } from '../lib/robotStatusClient'
import { RobotStateProvider } from '../lib/robotStateClient'
import { ensureRobotModelReady } from '../lib/robotModelClient'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'TanStack Start Starter',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  notFoundComponent: () => {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-lg font-semibold text-slate-200">Not Found</h1>
        <p className="mt-2 text-sm text-slate-400">
          The page you’re looking for doesn’t exist.
        </p>
      </div>
    )
  },

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Start model meta + GLB prefetch once per page load.
    ensureRobotModelReady().catch((err) => {
      console.warn('[model] startup prefetch failed', err)
    })
  }, [])

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <RobotStatusProvider>
          <RobotStateProvider>
            <Header />
            <ModelViewerHost />
            {children}
            <TanStackDevtools
              config={{
                position: 'bottom-right',
              }}
              plugins={[
                {
                  name: 'Tanstack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
            <Scripts />
          </RobotStateProvider>
        </RobotStatusProvider>
      </body>
    </html>
  )
}
