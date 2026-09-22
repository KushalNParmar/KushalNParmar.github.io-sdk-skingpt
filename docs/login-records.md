# Contact identity and scan history

The skin-analysis entry page finds or creates a contact in the dedicated Boltic
POC table before loading GlamAR. The PIM catalog API is not used here.

## SDK identity

Both email and phone number are required before any login request or SDK load.
Email is trimmed and lowercased. The phone field has a searchable country picker,
defaulting to United Kingdom (+44), populated from the bundled libphonenumber country
metadata. Search by country name, ISO code (including UK), or calling code. The
compact button shows the ISO and calling code; the full country appears in the
hint and options. Typing while the button is focused opens search. Arrow keys,
Home/End, Enter, Escape, and Tab support keyboard selection and dismissal.

Email uses a single-address web-form policy: an unquoted ASCII local part (up to
64 characters) and a dotted DNS-style domain with valid labels and a letter-based
or IDN suffix. Plus tags, apostrophes, subdomains and long domain extensions are
accepted; dots and tags are never removed. International domain names normalize
to their ASCII/punycode form. A locally bundled, MIT-licensed Punycode.js 2.3.1
decoder checks encoded labels consistently across browser URL implementations. Unicode local parts and quoted mailboxes are not
supported by this POC. Length checks apply to the encoded address (maximum 254).

Errors explain missing parts, spaces/invisible characters, invalid domain syntax
and excessive length. Native maxlength is omitted so pasted addresses cannot be
silently shortened. Raw paste/drop/insert events reject embedded control
characters before the browser can strip them into a different address. Rejected
insertions keep submission blocked until the user edits the email again.
Validation is local syntax checking, not a domain/MX, delivery or ownership
check. No third-party email validation service is called. The syntax/length
policy follows the practical [HTML email form model](https://html.spec.whatwg.org/multipage/input.html#email-state-(type=email))
and [SMTP size limits](https://www.rfc-editor.org/rfc/rfc5321#section-4.5.3.1),
with the public-style dotted-domain restriction described above.

Both fields validate on blur and revalidate while correcting errors. Phone
lengths use country metadata, followed by strict number validation; ten digits
is not a universal limit. Invalid characters and overlong typing/pastes are
rejected as a whole, never truncated into another number. A rejected edit leaves
an inline error until the user edits again. Country changes preserve the complete
number and revalidate it. Continue remains disabled until both fields are valid.
National formatting is applied on blur only when the phone is valid.

Users can enter a national number, including its national trunk prefix where
applicable, or paste an international number for the selected country. The
number is validated for that country and normalized to E.164 including `+`.
A missing phone validator blocks submission instead of bypassing validation.

Boltic's `phone_number` column stores country-code digits only, because its
Phone Number formatter adds the `+` for display. Lookups accept both the current
digits-only format and older stored values with `+`.

The POC uses the normalized phone number as the SDK user ID:

```js
configuration: {
  skinAnalysis: { appId, userId: normalizedPhone }
},
meta: { sdkVersion: "2.0.0" }
```

`meta.sessionId` is not sent. It is a separate capture-handoff identifier, not
the analysis user identity. Phone-based SDK identities remain unchanged.
The store also supports `userIdMethod: "email"` if the configured identity policy
is changed explicitly; the page uses the phone policy. Changing policies for
users previously scanned with another identifier can create a different backend
subject; it does not rewrite their existing Boltic scan history.

## Linking both contact details

`resolveContacts({email, phone})` performs independent exact lookups for both
normalized contacts. It does not use browser storage to select a record.

- If neither contact exists, create one row with both `email` and `phone_number`
  and `meta: []`. There is no `user_name` column, so that field is never sent.
- If both point to the same row, reuse it after confirming both values.
- If only one contact matches, read that row again and fill only a missing
  second contact. The PATCH does not replace `meta`, and both values are checked
  again after the write.
- If the supplied details point to separate rows, or the matched row already
  contains a different email/phone, stop with a contact-conflict message. This
  form does not merge accounts or replace existing contact details.
- Duplicate rows for an individual contact are rejected for manual resolution.

Normal returning logins do not write to Boltic. Scan saves remain bound to the
resolved row and both normalized contacts. The earlier single-contact resolver
remains available for compatibility, but the entry page always requires and
submits both contacts.

## Stored scan data

Boltic `meta` is a top-level JSON array:

```json
[
  {
    "scan-metadata": {
      "appId": "app-id",
      "predictionId": "prediction-1",
      "scanId": "scan-1",
      "subjectId": "subject-id",
      "retouchPredictionId": null,
      "pdfURL": "https://example.com/report-1.pdf"
    }
  },
  {
    "scan-metadata": {
      "appId": "app-id",
      "predictionId": "prediction-2",
      "scanId": "scan-2",
      "subjectId": "subject-id",
      "retouchPredictionId": null,
      "pdfURL": null
    }
  }
]
```

The wrapper callback is `skin-analysis` with
`{ options: "scan-metadata", value: metadata }`. This event arrives after the
visible `result`, PDF retrieval attempt, and retouch completion. The host stores
the JSON metadata value except `currencySymbols`, which is excluded. The key is
also removed from earlier scan entries on their next history save. It does not
copy images, access tokens, or raw `result` events into this
array. A `result` callback can also carry an error, so it is not used as evidence
of a completed scan. PDF/retouch fields may legitimately be null.

Listeners are registered immediately after the synchronous `GlamAR.init()` call
and before awaiting its result: init replaces the wrapper's event emitter.

## Append and retry behavior

`src/login-records.mjs` binds each scan save to the contact row resolved at login.
Each append:

1. Reads the latest record and verifies its ID and both normalized contacts.
2. Preserves the existing history and adds the new `scan-metadata` entry.
3. Patches only the `meta` column.
4. Reads the row back to confirm the new scan and retained history.

A scan is identified by `appId + scanId`. Duplicate callbacks do not add another
entry. Richer metadata updates the same entry; null/empty values do not erase a
previously saved PDF or identifier. Events need a nonempty scanId and the active
appId. Events and writes are queued within the page, so overlapping callbacks
cannot replace one another's arrays. Every attempt reads fresh server data.

`src/scan-history.mjs` keeps unsaved events in memory. The results remain visible
while saving. A failed save displays **Retry save**; another scan or a browser
`online` event also retries pending work. The queue clears an event only after
confirmation. A lost PATCH response is checked with a readback before reporting
failure; retries recognize a previously committed scan without duplicating it.

Pending events are not stored persistently in the browser. Closing/crashing the
page can lose unsaved events; a navigation warning is requested while saves are
pending, but mobile browsers do not guarantee it. The host can only save metadata
the SDK delivers; closing the iframe before its delayed metadata event cannot be
recovered by this integration.

## Existing metadata

Migration happens on the next scan save, not as a bulk table rewrite:

- Null metadata becomes an empty history.
- Existing JSON arrays are retained.
- JSON strings are parsed first.
- Older object metadata is converted into one historical entry. The obsolete
  `sessionId` and `glamAppId` keys are removed; any existing scan, result, or
  unknown fields are preserved. An identity-only object becomes empty history
  before appending the new scan.
- Malformed or primitive metadata blocks the save instead of discarding data.
  The SDK can still start, and the save failure is shown for investigation.

## API and limits

The configured table is:

`https://api.pixelbin.io/service/public/misc/v1.0/boltic-database/tables/768e99df-f9c4-4501-8725-19be6365337c/records`

| Operation | Method and relative path |
| --- | --- |
| Exact contact lookup | `POST /list` |
| Create contact with both details | `POST /` |
| Fill a missing contact field | `PATCH /{recordId}` |
| Read contact/history | `GET /{recordId}` |
| Save scan history | `PATCH /{recordId}` |

Requests omit credentials; the existing proxy supplies upstream credentials.
Requests time out after 15 seconds. Lookup/create errors stop initialization.
Multiple matching contacts are rejected instead of choosing a user's history
arbitrarily. A lost create response triggers a lookup, never a blind second
create within the same attempt.

The proxy exposes JSON replacement, not atomic array append or conditional
updates. The queue protects writes from this page only. Simultaneous writes from
separate devices/tabs can still overwrite each other. Production requires a
server-side transactional append/upsert, or a separate scan table with a unique
contact/app/scan key. Creating the same contact concurrently also needs a
server-side uniqueness guarantee.

The reviewed skin-analysis backend currently looks subjects up by `userId`
alone. This POC uses the exact contact requested; a multi-client rollout needs
backend identity isolation before reusing those contacts across applications.
This is contact capture without OTP or ownership verification, not authenticated
account access.

## Verification

```sh
node --test tests/contact-form.test.mjs tests/login-records.test.mjs tests/scan-history.test.mjs
```

Tests cover email/phone validation against the bundled number metadata,
country and prefix length rules, paired email/phone identity, required fields, returning users,
contact conflicts, filling missing contact details without altering scan history,
legacy metadata, append/deduplication, concurrent callbacks, readback checks,
timeouts, and retries after uncertain writes. Isolated browser checks cover SDK
configuration, two scans, duplicate events, retry UI, preserved history, and the
actual downloaded wrapper with controlled iframe events. Scan-save checks mock
Boltic/camera operations and do not insert fabricated live scan records.

Live array-column support was verified on 2026-09-22 by converting only the
previously supplied contact's identity-only metadata to `[]`: PATCH returned
202, and GET returned the exact JSON array. No live scan metadata was fabricated.
