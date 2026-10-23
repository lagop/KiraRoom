-- One row per signed-in browser or device, for refresh-token rotation:
-- the refresh token now lives in an httpOnly cookie and changes on every
-- refresh, and a replaced token presented again revokes its session.
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "currentJti" TEXT NOT NULL,
    "previousJti" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_sessions_subjectId_idx" ON "auth_sessions"("subjectId");
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");
