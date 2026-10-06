# RainReady

RainReady is a cloud-service prototype for helping organisers monitor weather risks across outdoor events, record decisions, and coordinate participant updates.

## Current prototype

The current milestone connects the browser prototype to a small local Node.js backend. Demo event records and illustrative risk scores remain in browser local storage; clicking **Check live weather** retrieves and displays current NEA forecast, rainfall, and lightning-observation data for that event's coordinates.

The prototype supports:

- viewing multiple outdoor events and their demo risk summaries;
- adding an event;
- reviewing a plain-language risk explanation;
- recording an organiser decision;
- simulating an official lightning alert to demonstrate the safety override;
- recording an in-app notification action and decision history;
- retrieving live source readings through the local backend and showing source freshness and nearest area/station.

**Important:** Live readings currently do not affect the illustrative demo risk score. Lightning observations are not an official warning or all-clear. A lightning alert simulation is not connected to NEA; the organiser must record the stop decision, and the system never auto-resumes an activity. No OneMap geocoding, email, authentication, or AWS deployment is included yet.

## Run locally

Requires Node.js 18 or later. Start the backend from the repository root:

```sh
node backend/server.mjs
```

Open `http://127.0.0.1:8787`. To run automated tests:

```sh
node --test backend/*.test.mjs
```

## Planned architecture

The planned cloud implementation is:

- Web interface: React frontend (the current static prototype will be migrated as the team modularises it), hosted on S3 and CloudFront;
- API: API Gateway and Lambda;
- Application data: DynamoDB;
- Scheduled ingestion: EventBridge Scheduler and Lambda;
- Historical datasets and reports: S3;
- Monitoring: CloudWatch.

The exact AWS services and permissions must be verified against the course account before deployment. Do not commit secrets, AWS credentials, or real participant contact details.

## Team workflow

Use short feature branches and Pull Requests. Keep `main` runnable; discuss API contract changes in `docs/api-contract.md` before frontend/backend work diverges. Never commit `.env` files, passwords, API keys, or personal participant data.

## Project status

This is an early course-project prototype. The local `/health` and `/api/weather` endpoints and on-demand NEA integration are implemented. Persistent events, authentication, automated refresh, institutional warning integration, evaluation, and AWS deployment remain planned work.
