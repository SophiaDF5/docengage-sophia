import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "../../lib/supabaseClient";
import { callPublicEdgeFunction } from "../../lib/apiClient";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

const RESEND_COOLDOWN_SECONDS = 60;

interface VerifyState {
  email?: string;
  password?: string;
}

export function VerifyCode() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as VerifyState) ?? {};

  // Register.tsx always passes email+password via route state. If someone
  // lands here cold (e.g. a page refresh, which clears route state), fall
  // back to asking for the email directly — we just won't be able to sign
  // them in automatically afterward since we never had their password.
  const [email, setEmail] = useState(state.email ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleVerify = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await callPublicEdgeFunction("doc_verify_email", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
      });

      if (state.password) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password: state.password,
        });
        if (signInError) {
          toast.success("Account verified! Please log in.");
          navigate("/login");
          return;
        }
        toast.success("Account verified — welcome to DocEngage!");
        navigate("/");
      } else {
        toast.success("Account verified! Please log in.");
        navigate("/login");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    try {
      await callPublicEdgeFunction("doc_resend_code", { email: email.trim().toLowerCase() });
      toast.success("If that email has a pending registration, a new code was sent.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resend code");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <img src="/favicon.svg" alt="DocEngage" className="h-12 w-12 mx-auto mb-2 rounded-xl" />
          <CardTitle className="text-2xl">Check your email</CardTitle>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code we sent to activate your account
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={!!state.email}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                required
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="text-center text-lg tracking-[0.5em]"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || code.length !== 6 || !email.trim()}>
              {loading ? "Verifying..." : "Verify & Continue"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={handleResend}
              disabled={cooldown > 0 || !email.trim()}
            >
              {cooldown > 0 ? `Resend Code (${cooldown}s)` : "Resend Code"}
            </Button>
            <p className="text-sm text-center text-muted-foreground">
              <Link to="/login" className="underline hover:text-foreground">
                Back to log in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
