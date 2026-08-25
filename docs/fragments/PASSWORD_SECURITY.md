# Password Security

> **Superseded by `37_Authentication_and_Login.md` §3.** Retained as historical source material only. Updated inline below to clarify this is delivered by Supabase Auth, not a custom implementation, per `00_Master.md` §7.2/§21.

Strong hashing, rate limiting, secure reset, no plaintext storage, and protection against account enumeration are all delivered through **Supabase Auth's** built-in email/password provider — not reimplemented by this application. No separate password store exists.
