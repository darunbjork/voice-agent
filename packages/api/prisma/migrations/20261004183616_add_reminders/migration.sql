-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "timeText" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_scheduledAt_idx" ON "reminders"("scheduledAt");
