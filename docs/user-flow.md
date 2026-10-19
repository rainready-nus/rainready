# RainReady core user flow

The local prototype presents four core user-visible views within one responsive single-page interface. For assessment screenshots, capture each state below at desktop width and, where practical, one mobile-width overview.

## 1. Sign in or create account

1. Open `http://127.0.0.1:8787`.
2. Sign in with an existing account, create a new organisation, or join with an owner-provided one-time invitation code.
3. Confirm that the active organisation and user role appear in the top bar.

Screenshot: authentication panel with no real credentials visible.

## 2. Create or edit an event

1. Select **Add event**.
2. Search OneMap for the main venue and explicitly select the correct result.
   If OneMap is not configured during a local demonstration, select **Use demo venue** instead; the saved name and address remain visibly labelled as demo data.
3. Optionally select a backup venue.
4. Enter the participant count, date, time, activity type and weather sensitivity, then save.

Screenshot: completed event form showing confirmed main and backup coordinates, using synthetic event data.

## 3. Review risk and advisories

1. Select **Check event-time risk** on an event. RainReady sends the saved date/time and main-venue coordinates to the backend.
2. RainReady selects the NEA two-hour forecast if its valid period covers the event start; otherwise it tries a covering period from the currently published NEA 24-hour regional forecast.
3. If the activity is 2–4 calendar days away and neither precise feed covers the start, review the provisional daily planning estimate, based on NEA's date-specific daily weather description, forecast high-temperature band and event sensitivity, plus preparation suggestions tailored to the weather and activity type. It is Singapore-wide, not venue/time-specific or calibrated; it excludes current rainfall, future PSI and backup-site comparison. Numeric wind severity is not scored without a validated unit. Recheck closer to the event.
4. Beyond four days, or if no fresh four-day outlook is available, the page explicitly says that no official forecast is currently available and does not show an estimate.
5. For a covered event start, review the score, matched forecast window, source freshness and the note that current rainfall and unvalidated historical probability are excluded from this time-aligned score.
6. If a backup venue is saved and precise event-time forecast coverage exists, select **Check backup venue**. RainReady compares scores only when both readings are current and the exact forecast-window boundaries match. This button/comparison is not available for a daily planning outlook.
7. For covered event-start assessments, review the separate nearest-region 24-hour PSI advisory and inspect lightning observations as context only.
8. To demonstrate the safety path, select **Confirm demo alert**, then run **Check live risk** again. The backend must return the stop-and-shelter override.

Screenshot: expanded assessment showing routine breakdown, PSI advisory and either inactive or active lightning override.

## 4. Confirm organiser action

1. Select **Record decision**.
2. Choose continue, prepare, relocate, postpone or cancel and enter a reason.
3. Confirm the decision and review the generated notification preview.
4. Verify that the preview is labelled `TEST MODE`, `NOT SENT`, and appears in decision history.

Screenshot: decision form and notification preview, with no participant personal data.

## Safety assumptions to state during the demonstration

- Routine risk weights are RainReady prototype assumptions, not official NEA thresholds.
- Historical probability `H` is excluded until validated event-matched data exist; remaining available weights are renormalised.
- Event-time risk covers only the scheduled start, not the full activity duration. NEA's currently published forecast may not cover a future event; no score means manual review/recheck, not low risk.
- The 24-hour forecast is regional; RainReady's region assignment is a prototype approximation. A lower backup-site weather score does not confirm that the venue is accessible, suitable, safe or available.
- The PSI advisory follows published NEA 24-hour PSI bands but is not medical advice and is not included in the routine weather score.
- Lightning observations are neither an official warning nor an all-clear. The stop-and-shelter path is activated only by an explicit organiser-confirmed demo alert.
- Clearing an alert does not automatically resume an event; a human organiser reassesses and records the decision.
