# Contact identity and scan history

The skin-analysis entry page finds or creates a contact in the dedicated Boltic
POC table before loading GlamAR. The PIM catalog API is not used here.

## SDK identity

Email is trimmed and lowercased. Phone validation produces an international
E.164 number including `+`. Returning users are looked up by the same normalized
contact on every login; no browser storage decides whether a record exists.
Phone lookup also accepts the same country-code number stored without `+`.

The normalized contact is the stable SDK user ID:

```js
configuration: {
  skinAnalysis: { appId, userId: normalizedContact }
},
meta: { sdkVersion: "2.0.0" }
```

`meta.sessionId` is not sent. It is a separate SDK capture-handoff identifier,
not the analysis user identity. An older Boltic `meta.sessionId` never overrides
the entered contact. Email and phone remain separate identities unless a row
already contains both; entering them separately does not establish ownership.

New contact rows contain `email`, `phone_number`, and `meta: []`. Both contact
keys must be supplied; the unused one is `null`. These columns are nullable.
There is no `user_name` column in this table, so it must not be sent.
Returning login performs only the filtered lookup and does not rewrite history.

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

1. Reads the latest record and verifies both its ID and normalized contact.
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
| Create contact | `POST /` |
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
node --test tests/login-records.test.mjs tests/scan-history.test.mjs
```

Tests cover email/phone identity, nullable contact fields, returning users,
legacy metadata, append/deduplication, concurrent callbacks, readback checks,
timeouts, and retries after uncertain writes. Isolated browser checks cover SDK
configuration, two scans, duplicate events, retry UI, preserved history, and the
actual downloaded wrapper with controlled iframe events. Scan-save checks mock
Boltic/camera operations and do not insert fabricated live scan records.

Live array-column support was verified on 2026-09-22 by converting only the
previously supplied contact's identity-only metadata to `[]`: PATCH returned
202, and GET returned the exact JSON array. No live scan metadata was fabricated.
