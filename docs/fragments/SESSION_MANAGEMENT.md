# Session Management

> **Superseded by `37_Authentication_and_Login.md` §4.** Retained as historical source material only. The original text described access/refresh tokens generically, which could be misread as a custom-built token system. Updated inline below to name the token authority explicitly, per `00_Master.md` §7.2.

**Supabase Auth** owns access/refresh token issuance, expiration, and rotation — no separate/competing token system is built. Application-level `DeviceSession` records provide secure device/session metadata only: session listing, revocation, logout and logout-all, device awareness, and security events. `DeviceSession` never stores or issues credentials itself; it references the Supabase Auth session it describes.
