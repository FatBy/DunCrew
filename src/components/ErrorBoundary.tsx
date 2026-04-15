import { Component, type ReactNode } from 'react'
import { crashMonitor } from '@/services/crashMonitor'
import { useT } from '@/i18n'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onRetry?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
    
    // 记录到崩溃监控
    crashMonitor.logReactError(error, info.componentStack || undefined)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onRetry?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const t = useT()
      
      return this.props.fallback ?? (
        <div style={{ 
          padding: 20, 
          color: '#ff6b6b', 
          fontFamily: 'monospace', 
          fontSize: 14,
          background: 'rgba(0,0,0,0.8)',
          borderRadius: 8,
          margin: 20,
        }}>
          <h2 style={{ margin: '0 0 10px', color: '#ff8888' }}>{t('common.render_error')}</h2>
          <pre style={{ 
            whiteSpace: 'pre-wrap', 
            wordBreak: 'break-all',
            color: '#ffaaaa',
            fontSize: 12,
            maxHeight: 200,
            overflow: 'auto',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.handleRetry}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 6,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
