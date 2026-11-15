import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button, Notice } from "./ui";

interface Props {
  children: ReactNode;
  /** When this changes, a page that failed is tried again (the section the admin opens next). */
  resetKey?: string;
}

interface State {
  failed: boolean;
  resetKey?: string;
}

/**
 * Keeps one broken page from blanking the whole dashboard. What failed is logged to the
 * browser console only; nothing is sent anywhere.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Admin dashboard page failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid justify-items-start gap-3 py-6">
        <Notice>This page couldn’t be shown. Reload to try again, or open another section.</Notice>
        <Button size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
