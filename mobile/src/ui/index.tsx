// Layer 12A §31–32 — the small shared UI kit.
//
// Accessibility: interactive elements have roles, labels and a 48pt minimum
// touch target; states are always spelled out in text (never colour alone);
// text scales with the system font size. Layout uses start/end, not left/right.

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text as RNText, TextInput, View, type TextInputProps, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isApiError } from '../api/errors';
import { t, type MessageKey } from '../i18n';
import { theme } from './theme';

type TextVariant = 'title' | 'heading' | 'body' | 'muted' | 'small' | 'error';

const textStyles: Record<TextVariant, TextStyle> = {
  title: { fontSize: theme.font.title, fontWeight: '700', color: theme.color.text },
  heading: { fontSize: theme.font.heading, fontWeight: '600', color: theme.color.text },
  body: { fontSize: theme.font.body, color: theme.color.text },
  muted: { fontSize: theme.font.body, color: theme.color.textMuted },
  small: { fontSize: theme.font.small, color: theme.color.textMuted },
  error: { fontSize: theme.font.body, color: theme.color.danger },
};

export function Text({ variant = 'body', children, testID, accessibilityRole }: { variant?: TextVariant; children: ReactNode; testID?: string; accessibilityRole?: 'header' | 'text' | 'alert' }) {
  return (
    <RNText style={[textStyles[variant], { textAlign: 'auto' }]} testID={testID} accessibilityRole={accessibilityRole ?? (variant === 'title' || variant === 'heading' ? 'header' : undefined)}>
      {children}
    </RNText>
  );
}

export function Screen({ children, scroll = true, testID }: { children: ReactNode; scroll?: boolean; testID?: string }) {
  const content = <View style={{ padding: theme.space.lg, gap: theme.space.md }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }} edges={['top', 'left', 'right']} testID={testID}>
      {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1 }}>{content}</ScrollView> : content}
    </SafeAreaView>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  accessibilityHint,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  testID?: string;
}) {
  const primary = variant === 'primary';
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({
        minHeight: theme.touchTarget,
        paddingHorizontal: theme.space.lg,
        borderRadius: theme.radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? theme.color.primary : theme.color.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.color.border,
        opacity: inactive ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <RNText style={{ fontSize: theme.font.body, fontWeight: '600', color: primary ? theme.color.onPrimary : theme.color.text }}>{label}</RNText>
    </Pressable>
  );
}

export function Input({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: theme.space.xs }}>
      <RNText style={textStyles.small}>{label}</RNText>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.color.textMuted}
        style={{
          minHeight: theme.touchTarget,
          borderWidth: 1,
          borderColor: theme.color.border,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.space.md,
          fontSize: theme.font.body,
          color: theme.color.text,
          textAlign: 'auto',
        }}
        {...props}
      />
    </View>
  );
}

export function Card({ children, testID, accessibilityLabel }: { children: ReactNode; testID?: string; accessibilityLabel?: string }) {
  return (
    <View
      testID={testID}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={{ backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.space.lg, gap: theme.space.sm }}
    >
      {children}
    </View>
  );
}

export function Notice({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View testID={testID} accessibilityRole="alert" style={{ backgroundColor: theme.color.noticeBackground, borderRadius: theme.radius.sm, padding: theme.space.md }}>
      <RNText style={{ color: theme.color.notice, fontSize: theme.font.body }}>{children}</RNText>
    </View>
  );
}

export function LoadingState({ label = t('common.loading') }: { label?: string }) {
  return (
    <View testID="loading-state" accessibilityRole="progressbar" accessibilityLabel={label} style={{ padding: theme.space.xl, alignItems: 'center', gap: theme.space.sm }}>
      <ActivityIndicator color={theme.color.primary} />
      <Text variant="muted">{label}</Text>
    </View>
  );
}

/** Maps any error to a safe, translated message. Never shows raw server text. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return t(`error.${error.kind}` as MessageKey);
  return t('error.unknown');
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const requestId = isApiError(error) ? error.requestId : null;
  return (
    <View testID="error-state" accessibilityRole="alert" style={{ padding: theme.space.lg, gap: theme.space.md }}>
      <Text variant="error">{errorMessage(error)}</Text>
      {requestId ? <Text variant="small">{t('common.requestId', { id: requestId })}</Text> : null}
      {onRetry ? <Button label={t('common.retry')} onPress={onRetry} variant="secondary" /> : null}
    </View>
  );
}

export function EmptyState({ message, testID = 'empty-state' }: { message: string; testID?: string }) {
  return (
    <View testID={testID} style={{ padding: theme.space.xl, alignItems: 'center' }}>
      <Text variant="muted">{message}</Text>
    </View>
  );
}

/** A selectable option (meal type, serving, unit). Selection is announced, not shown by colour alone. */
export function Choice({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      testID={testID}
      style={{
        minHeight: theme.touchTarget,
        paddingHorizontal: theme.space.md,
        borderRadius: theme.radius.md,
        justifyContent: 'center',
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.color.primary : theme.color.border,
        backgroundColor: selected ? theme.color.background : theme.color.surface,
      }}
    >
      <RNText style={{ fontSize: theme.font.body, color: theme.color.text, fontWeight: selected ? '700' : '400' }}>{selected ? `✓ ${label}` : label}</RNText>
    </Pressable>
  );
}

export function ChoiceRow({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>{children}</View>;
}

/** A tappable list row. */
export function Row({ children, onPress, accessibilityLabel, testID }: { children: ReactNode; onPress: () => void; accessibilityLabel: string; testID?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({ backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.space.lg, gap: theme.space.xs, minHeight: theme.touchTarget, opacity: pressed ? 0.8 : 1 })}
    >
      {children}
    </Pressable>
  );
}
