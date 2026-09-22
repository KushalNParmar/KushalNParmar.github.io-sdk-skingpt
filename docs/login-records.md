# Login record association

The skin-analysis entry page saves the submitted contact in Boltic before loading
the GlamAR SDK. The PIM catalog API is not used for login records.

## Identity and returning users

- Email is trimmed and lowercased. Provider-specific aliases (dots or `+tags`)
  are not removed.
- Phone validation returns a full international E.164 number, including `+`.
- Phone lookup also accepts existing records saved with the same country code
  and number but no `+`, matching the supplied Kwikpass integration's format.
- Every login looks up that normalized contact in Boltic. No localStorage or
  cookies are used to decide whether a user already exists.
- A new contact creates a record with `email` or `phone_number`, an empty
  `user_name`, and `meta: { sessionId: normalizedContact, glamAppId: appId }`.
- An existing record reuses its saved `meta.sessionId` unchanged. If it has no
  session yet, the page adds one while preserving the other metadata and contact
  fields. The API write is read back before initializing the SDK.
- The exact stored session is passed to `GlamAR.init(..., { meta: {
  sdkVersion: "2.0.0", sessionId } })`. Normal returning logins perform no writes.
- Email and phone are separate identities unless an existing record already
  contains both. This does not infer that two separately entered contacts belong
  to the same person.

## API

`index.html` configures the table URL from the supplied reference:

`https://api.pixelbin.io/service/public/misc/v1.0/boltic-database/tables/e25e9e02-740d-4d31-8056-9f463781adfc/records`

`src/login-records.mjs` calls:

| Operation | Method and relative path |
| --- | --- |
| Exact contact lookup | `POST /list` |
| Create contact | `POST /` |
| Read saved record | `GET /{recordId}` |
| Link a record with no session | `PATCH /{recordId}` |

The lookup sends a body such as:

```json
{
  "page": { "page_no": 1, "page_size": 2 },
  "sort": [{ "field": "created_at", "direction": "asc" }],
  "filters": [{ "field": "email", "operator": "=", "values": ["user@example.com"] }],
  "fields": ["id", "email", "phone_number", "meta"]
}
```

Requests omit credentials; the existing proxy handles its upstream credentials.
No Boltic token is embedded in the page. The live filtered-list contract was
verified with a nonexistent example.invalid identity; mutation checks use mocks.

## Failure handling and limits

Lookup, persistence, or response-validation failures stop SDK initialization and
restore the login form for retry. Requests time out after 15 seconds. A failed
create response triggers a fresh lookup in case the write already succeeded;
it does not blindly create a second row. In-flight submissions for the same
contact are deduplicated within the page. Multiple matching rows stop the flow
instead of selecting an arbitrary history.

This proxy exposes separate lookup/create operations, not a confirmed atomic
upsert. Two first-ever logins for the same contact on different devices can race.
For a production uniqueness guarantee, add a server-side find-or-create operation
backed by a unique normalized identity constraint. Do not add a simple unique
constraint to both contact columns while unused values are stored as empty
strings; use a suitable dedicated identity key or partial constraints. Existing
contacts stored in older, noncanonical formats may need a one-time migration.
National phone numbers without a country code are not automatically merged.

This is contact capture without OTP or ownership verification, as requested.
It is not an authenticated account login. This change stores the contact/session
association only; it does not add scan-result syncing or a history UI.

## Checks

Run the record-flow tests using Node.js:

```sh
node --test tests/login-records.test.mjs
```

Browser checks also cover email/phone validation, SDK startup order, returning
users in a fresh browser context, legacy metadata preservation, SDK failures,
database retries, lost create responses, and duplicate-record handling. These
checks mock SDK and Boltic writes; they do not add fake users to the live table.
