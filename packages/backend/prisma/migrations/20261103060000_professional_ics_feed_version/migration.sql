-- A professional's own calendar feed version (ics.controller.ts): added to
-- the salon's feed version, and bumped when the salon removes their panel
-- access, so their subscribed calendar stops receiving the agenda.
-- Additive: every existing professional starts at 0, so the links already
-- handed out keep verifying.
ALTER TABLE "professionals" ADD COLUMN "icsFeedVersion" INTEGER NOT NULL DEFAULT 0;
