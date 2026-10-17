# Delta for admin-auth

New capability. Replaces the "Basic Auth on all admin routes" requirement of `admin-ui` (see the REMOVED section in the admin-ui delta).

## ADDED Requirements

### Requirement: Login page

The system SHALL serve a login page at `GET /admin/login` that asks for the admin password. `POST /admin/login` MUST compare the submitted password against `ADMIN_PASSWORD` using a constant-time comparison (SHA-256 digests compared with `timingSafeEqual`). On success the system MUST set the session cookie and redirect (303) to the validated return path. On failure it MUST respond 401 with the login page and the message "Contraseña incorrecta. Inténtalo de nuevo.", and MUST NOT set a cookie.

#### Scenario: Correct password
- GIVEN the admin is enabled and has no session
- WHEN they POST the correct password to `/admin/login`
- THEN the response sets `nh_session` and redirects to the return path

#### Scenario: Wrong password
- GIVEN the admin is enabled
- WHEN a wrong password is POSTed to `/admin/login`
- THEN the response is 401, no cookie is set, and the page shows "Contraseña incorrecta. Inténtalo de nuevo."

#### Scenario: Login page copy
- GIVEN the login page is rendered
- WHEN the admin reads it
- THEN it states "La sesión dura 8 horas en este navegador."

### Requirement: Signed stateless session cookie

On successful login the system SHALL issue a cookie named `nh_session` whose value is a payload `{iat, exp}` plus an `HMAC-SHA256` signature keyed with `SESSION_SECRET`. The cookie MUST have the attributes `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/admin`. The lifetime MUST be 8 hours, absolute (`exp = iat + 8h`), with no sliding renewal. Signature verification MUST be constant-time. A cookie with a bad signature, a malformed value, or `exp` in the past MUST be treated as no session. The system MUST NOT keep server-side session state.

#### Scenario: Cookie attributes
- GIVEN a successful login
- WHEN the response is inspected
- THEN `nh_session` carries `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/admin` and an 8 hour expiry

#### Scenario: Tampered cookie
- GIVEN a cookie whose payload was altered after signing
- WHEN any admin page is requested with it
- THEN it is treated as unauthenticated

#### Scenario: Expired session
- GIVEN a valid cookie issued more than 8 hours ago
- WHEN an admin page is requested
- THEN it is treated as unauthenticated, even if the admin was active in between

#### Scenario: Survives restart
- GIVEN a valid session and a process restart with the same `SESSION_SECRET` and `ADMIN_PASSWORD`
- WHEN an admin page is requested with the same cookie
- THEN the session is still valid

### Requirement: Password change revokes sessions

The session payload MUST carry a password binding derived as `HMAC(SESSION_SECRET, ADMIN_PASSWORD)` truncated to 16 bytes (hex or equivalent). A session whose binding does not match the current `ADMIN_PASSWORD` MUST be rejected.

#### Scenario: Password rotated
- GIVEN a valid session issued under the old `ADMIN_PASSWORD`
- WHEN `ADMIN_PASSWORD` changes and the admin requests a page
- THEN the session is rejected and the admin is redirected to login

### Requirement: Separate session secret and fail-closed

`SESSION_SECRET` MUST be a dedicated env var of at least 32 bytes and MUST NOT be derived from `ADMIN_PASSWORD`. If `SESSION_SECRET` is unset or shorter than 32 bytes, or `ADMIN_PASSWORD` is unset, all admin routes (including login) MUST respond 403 and a warning MUST be logged without revealing secret values. The service MUST still boot and `/health` and the webhook/Slack routes MUST keep working.

#### Scenario: Missing secret
- GIVEN `SESSION_SECRET` is not configured
- WHEN `GET /admin/login` is requested
- THEN the response is 403 and a warning is logged

#### Scenario: Short secret
- GIVEN `SESSION_SECRET` has fewer than 32 bytes
- WHEN any admin route is requested
- THEN the response is 403

#### Scenario: Webhooks unaffected
- GIVEN the admin is disabled for a missing secret
- WHEN a correctly signed webhook or `GET /health` is received
- THEN it is handled normally

### Requirement: Logout

`POST /admin/logout` MUST clear `nh_session` (same attributes, expired) and redirect to `/admin/login`. It MUST require a valid CSRF token and a same-origin request like every other POST.

#### Scenario: Logout
- GIVEN an authenticated admin
- WHEN they submit the logout form
- THEN the cookie is cleared and a later request to an admin page redirects to login

#### Scenario: Cross-site logout
- GIVEN a POST to `/admin/logout` from a foreign origin
- WHEN handled
- THEN it is rejected and the session stays

### Requirement: Unauthenticated access

An unauthenticated `GET` of any admin page (except login and assets) MUST redirect (302/303) to `/admin/login?next=<original path and query>`. An unauthenticated `POST` MUST respond 401 and MUST NOT change state. Responses MUST NOT include admin data.

#### Scenario: Redirect to login
- GIVEN no session
- WHEN `GET /admin/people` is requested
- THEN the response redirects to `/admin/login?next=%2Fadmin%2Fpeople`

#### Scenario: Unauthenticated POST
- GIVEN no session
- WHEN a form POST is sent to a state-changing route
- THEN the response is 401 and nothing changes

### Requirement: Return-to allow-list

`next` MUST be honored only if it matches `^/admin(/[A-Za-z0-9/_-]*)?(\?[^#]*)?$`. Otherwise the post-login redirect MUST go to `/admin/status`. The value MUST be carried through the login form without being rendered unescaped.

#### Scenario: Internal path
- GIVEN `next=/admin/channels`
- WHEN login succeeds
- THEN the redirect goes to `/admin/channels`

#### Scenario: External URL
- GIVEN `next=https://evil.example/admin`
- WHEN login succeeds
- THEN the redirect goes to `/admin/status`

#### Scenario: Protocol-relative or traversal-like value
- GIVEN `next=//evil.example` or `next=/admin/../x`
- WHEN login succeeds
- THEN the redirect goes to `/admin/status`

### Requirement: Login rate limiting

The system MUST count failed logins in memory and return HTTP 429 with the message "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." and a `Retry-After` header when either limit is reached: 5 failures per client IP within 15 minutes, or 30 failures globally within 15 minutes. The client IP MUST be the last hop of `X-Forwarded-For`, or the socket address when that header is absent. While limited, even a correct password MUST NOT log in. Counters MAY reset on restart. Successful logins MUST NOT count as failures.

#### Scenario: Sixth failure from one IP
- GIVEN 5 failed logins from IP X in the last 15 minutes
- WHEN X sends a 6th attempt
- THEN the response is 429 with the Spanish message

#### Scenario: Correct password while limited
- GIVEN IP X is rate limited
- WHEN X submits the correct password
- THEN the response is 429 and no cookie is set

#### Scenario: Global cap
- GIVEN 30 failures from distinct IPs within 15 minutes
- WHEN any client attempts to log in
- THEN the response is 429

#### Scenario: Spoofed leading XFF hop
- GIVEN `X-Forwarded-For: 1.1.1.1, 9.9.9.9`
- WHEN a login fails
- THEN the failure is counted against `9.9.9.9`

#### Scenario: Window expiry
- GIVEN failures older than 15 minutes
- WHEN a new attempt is made
- THEN the old failures no longer count

### Requirement: Session-bound CSRF

Every state-changing admin POST MUST pass an `Origin` check (same origin as the service) and MUST carry a CSRF token equal to `HMAC(SESSION_SECRET, "csrf:" + iat)` of the current session. The login POST MUST pass the `Origin` check. A missing or mismatching token, or a foreign `Origin`, MUST be rejected with 403 and no state change. The token MUST remain valid across process restarts while the session is valid.

#### Scenario: Valid token
- GIVEN an authenticated admin submitting a form with the token rendered in it
- WHEN the POST is handled
- THEN it is accepted

#### Scenario: Missing token
- GIVEN a valid session cookie but no CSRF token
- WHEN a state-changing POST is sent
- THEN 403 and no state changes

#### Scenario: Token from another session
- GIVEN a token minted for a different `iat`
- WHEN a POST is sent
- THEN 403

#### Scenario: Foreign origin on login
- GIVEN a POST to `/admin/login` with a foreign `Origin`
- WHEN handled
- THEN it is rejected and no cookie is set

### Requirement: Basic Auth no longer accepted

The system MUST NOT authenticate any admin request from an `Authorization: Basic` header. No `WWW-Authenticate` challenge SHALL be sent.

#### Scenario: Basic header
- GIVEN a request with a valid `Authorization: Basic` for `ADMIN_PASSWORD` and no session cookie
- WHEN an admin page is requested
- THEN the response redirects to login and no admin data is returned

### Requirement: Auth secrets never exposed

`SESSION_SECRET`, the session cookie value, and CSRF tokens MUST NOT appear in logs, error messages, or HTML other than the CSRF token inside its own form.

#### Scenario: Failed login log
- GIVEN a failed login or a rejected cookie
- WHEN the event is logged
- THEN the log contains neither the submitted password, the cookie, nor `SESSION_SECRET`
