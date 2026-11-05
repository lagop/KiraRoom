-- Audit 8 C1 follow-up: marker table for one-time jobs run after boot.
CREATE TABLE "maintenance_tasks" (
    "name" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "maintenance_tasks_pkey" PRIMARY KEY ("name")
);
