import { Component, type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useT } from '@/i18n'

interface Props {
  children: ReactNode
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: string | null
}

export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message }
  }

  handleReset = () => {
    this.props.onReset?.()
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const t = useT()
      
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <AlertCircle className="w-8 h-8 text-red-400/50 mb-3" />
          <p className="text-xs font-mono text-red-400/70 mb-2">{t('chat_error.render_error')}</p>
          <p className="text-[13px] font-mono text-stone-300 mb-4 max-w-[200px] break-all">
            {this.state.error}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                       bg-stone-100/80 border border-stone-200 rounded-lg
                       text-stone-400 hover:text-amber-400 hover:border-amber-500/30 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {t('chat_error.clear_and_retry')}
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
