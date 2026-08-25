-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'BASE_ASSET_GENERATING', 'BASE_ASSET_SCORING', 'LOGO_PLACEMENT_DETECTING', 'LOGO_COMPOSITING', 'POSTER_GENERATING', 'POSTER_SCORING', 'AWAITING_APPROVAL', 'DIMENSION_EXPANDING', 'COMPLETE', 'NEEDS_ATTENTION', 'REJECTED');

-- CreateEnum
CREATE TYPE "StageAttemptResult" AS ENUM ('PASS', 'RETRY', 'ESCALATED');

-- CreateEnum
CREATE TYPE "DimensionStatus" AS ENUM ('PENDING', 'GENERATING', 'SCORING', 'DELIVERED', 'NEEDS_ATTENTION');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "reference1Url" TEXT NOT NULL,
    "reference2Url" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "baseAssetUrl" TEXT,
    "posterUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costInr" DECIMAL(65,30) NOT NULL,
    "qaScore" DECIMAL(65,30),
    "boundingBoxJson" JSONB,
    "result" "StageAttemptResult" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StageAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DimensionJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "status" "DimensionStatus" NOT NULL DEFAULT 'PENDING',
    "assetUrl" TEXT,

    CONSTRAINT "DimensionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "StageAttempt_jobId_idx" ON "StageAttempt"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "StageAttempt_jobId_stage_attemptNumber_key" ON "StageAttempt"("jobId", "stage", "attemptNumber");

-- CreateIndex
CREATE INDEX "DimensionJob_jobId_idx" ON "DimensionJob"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLog_jobId_key" ON "ApprovalLog"("jobId");

-- AddForeignKey
ALTER TABLE "StageAttempt" ADD CONSTRAINT "StageAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DimensionJob" ADD CONSTRAINT "DimensionJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalLog" ADD CONSTRAINT "ApprovalLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

