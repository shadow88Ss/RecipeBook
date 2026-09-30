// Layer 12A §20–21 — signed-out screen with email/password sign-in.
// No registration flow is added here (no new registration policy in 12A).

import { useState } from 'react';

import type { SignInFailure, OAuthFailure } from '../../auth/authService';
import { useAuth } from '../../auth/AuthProvider';
import { t, type MessageKey } from '../../i18n';
import { useServices } from '../../state/AppProviders';
import { Button, Input, Notice, Screen, Text } from '../../ui';

export function SignInScreen() {
  const { signInWithPassword, signInWithOAuth, notice } = useAuth();
  const { config } = useServices();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | OAuthFailure | 'missing' | null>(null);

  async function submit() {
    if (!email.trim() || !password) {
      setFailure('missing');
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await signInWithPassword(email, password);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.reason);
      setPassword('');
    }
  }

  async function oauth(provider: 'google' | 'apple') {
    setBusy(true);
    setFailure(null);
    const result = await signInWithOAuth(provider);
    setBusy(false);
    if (!result.ok) setFailure(result.reason);
  }

  const failureText = failure === 'missing' ? t('auth.signIn.missing') : failure ? t(`auth.error.${failure}` as MessageKey) : null;

  return (
    <Screen testID="sign-in-screen">
      <Text variant="title">{t('app.name')}</Text>
      <Text variant="heading">{t('auth.signIn.title')}</Text>
      <Text variant="muted">{t('auth.signIn.subtitle')}</Text>
      {notice === 'session_expired' ? <Notice testID="session-expired">{t('auth.sessionExpired')}</Notice> : null}
      <Input
        label={t('auth.email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        testID="email-input"
      />
      <Input
        label={t('auth.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        testID="password-input"
      />
      {failureText ? (
        <Text variant="error" accessibilityRole="alert" testID="sign-in-error">
          {failureText}
        </Text>
      ) : null}
      <Button label={busy ? t('auth.signIn.submitting') : t('auth.signIn.submit')} onPress={submit} busy={busy} testID="sign-in-submit" />
      {config.oauthProviders.includes('google') ? <Button label={t('auth.signIn.withGoogle')} onPress={() => oauth('google')} variant="secondary" disabled={busy} /> : null}
      {config.oauthProviders.includes('apple') ? <Button label={t('auth.signIn.withApple')} onPress={() => oauth('apple')} variant="secondary" disabled={busy} /> : null}
      {config.oauthProviders.length === 0 ? <Text variant="small">{t('auth.signIn.oauthUnavailable')}</Text> : null}
    </Screen>
  );
}
