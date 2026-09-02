-- CreateTable
CREATE TABLE "AssetEdit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sourceAssetUrl" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "resultAssetUrl" TEXT,
    "errorMessage" TEXT,
    "costInr" DECIMAL(65,30),
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AssetEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetEdit_jobId_target_idx" ON "AssetEdit"("jobId", "target");

-- AddForeignKey
ALTER TABLE "AssetEdit" ADD CONSTRAINT "AssetEdit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
