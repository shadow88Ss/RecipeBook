// Layer 12A §33 — a neutral, replaceable theme. Screens read tokens from here
// only, so the visual design can be swapped without touching them.

export const theme = {
  color: {
    background: '#FFFFFF',
    surface: '#F5F5F4',
    border: '#D6D3D1',
    text: '#1C1917',
    textMuted: '#57534E',
    primary: '#1D4ED8',
    onPrimary: '#FFFFFF',
    danger: '#B91C1C',
    notice: '#92400E',
    noticeBackground: '#FEF3C7',
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 6, md: 10 },
  font: { small: 13, body: 16, title: 22, heading: 18 },
  /** Minimum touch target (Apple HIG 44pt; Material 48dp). */
  touchTarget: 48,
} as const;

export type Theme = typeof theme;
