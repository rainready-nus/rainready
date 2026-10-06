# RainReady

RainReady is a cloud-service prototype for helping organisers monitor weather risks across outdoor events, record decisions, and coordinate participant updates.

## Current prototype

The first milestone is a browser-based, interactive frontend prototype in `frontend/index.html`. It uses clearly labelled sample data and browser local storage so the team can test the user journey before the backend and official data integrations are ready.

The prototype supports:

- viewing multiple outdoor events and their demo risk summaries;
- adding an event;
- reviewing a plain-language risk explanation;
- recording an organiser decision;
- simulating an official lightning alert to demonstrate the safety override;
- recording an in-app notification action and decision history.

**Important:** The prototype does not yet call NEA, OneMap, AWS, email, or any live weather API. The sample scores are for interface demonstration only and are not operational safety guidance. A lightning alert simulation requires the organiser to record the stop decision; the system never auto-resumes an activity.

## Run locally

Open `frontend/index.html` in a modern browser. No package installation is needed for this initial UI prototype.

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

This is an early course-project prototype. The frontend currently uses demonstration fixtures; backend APIs, authentication, official data ingestion, evaluation, and AWS deployment remain planned work.
