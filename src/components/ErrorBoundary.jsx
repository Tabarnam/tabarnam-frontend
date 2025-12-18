import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (typeof this.props.onError === "function") {
      try {
        this.props.onError(error, errorInfo);
      } catch {
        // ignore
      }
    }
  }

  componentDidUpdate(prevProps) {
    const prevKeys = Array.isArray(prevProps.resetKeys) ? prevProps.resetKeys : null;
    const nextKeys = Array.isArray(this.props.resetKeys) ? this.props.resetKeys : null;
    if (!this.state.hasError) return;
    if (!prevKeys || !nextKeys || prevKeys.length !== nextKeys.length) return;

    for (let i = 0; i < nextKeys.length; i += 1) {
      if (!Object.is(prevKeys[i], nextKeys[i])) {
        this.reset();
        return;
      }
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const fallback = this.props.fallback;
      if (typeof fallback === "function") {
        return fallback({ error: this.state.error, reset: this.reset });
      }
      return fallback ?? null;
    }

    return this.props.children;
  }
}
