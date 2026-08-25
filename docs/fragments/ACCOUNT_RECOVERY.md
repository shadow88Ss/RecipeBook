# Account Recovery

> **Superseded by `37_Authentication_and_Login.md` §8.** Retained as historical source material only. Updated inline below to name the token/credential authority explicitly.

Password reset and verification resend run through **Supabase Auth's** built-in flows. Social-provider (Apple/Google) recovery follows the provider's own path via Supabase Auth. Relinking a provider identity to an existing Account requires proof of ownership (see `37_Authentication_and_Login.md` §7) and never silently creates a second Account.
