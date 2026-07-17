import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Without this, any uncaught error in a page component (a bad query, a null
// dereference, a bug in a new feature) unmounts the entire React tree and
// leaves the user staring at a blank white screen with no indication of
// what happened. This catches that at the render level and shows a real
// message + a way to recover, instead of "nothing loads."
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in app tree:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <div className="max-w-md text-center space-y-3">
            <p className="text-lg font-semibold">Something went wrong</p>
            <p className="text-sm text-muted-foreground">
              {this.state.error.message || "The app hit an unexpected error."}
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => this.setState({ error: null })}
              >
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
