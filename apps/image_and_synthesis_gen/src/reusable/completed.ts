export interface CompletedReusableImage {
  generatedFileName: string;
  key: string;
}

// Durable inventory of the renders completed before the broader category and
// agency backfill was paused. The publisher resolves these basenames from
// caller-provided files/directories; generated images do not belong in git.
export const COMPLETED_REUSABLE_IMAGES: readonly CompletedReusableImage[] = [
  {
    generatedFileName: "exec-da3818ef-1698-454b-9d61-abbf59e2500d.png",
    key: "immigration-and-border",
  },
  {
    generatedFileName: "exec-3b37ca6c-6c4f-48d4-9958-62152f7f0212.png",
    key: "public-health",
  },
  {
    generatedFileName: "exec-e89e1af7-c4d5-4c95-90c8-f665ecc5f0f2.png",
    key: "food-and-drug-safety",
  },
  {
    generatedFileName: "exec-c5edd1af-547c-4a73-a2ef-f4ae6426b886.png",
    key: "defense-and-military",
  },
  {
    generatedFileName: "exec-948bd3c6-3bcb-4376-a36a-3a975868e936.png",
    key: "veterans-affairs",
  },
  {
    generatedFileName: "exec-05589839-1e07-462c-8292-8f84081abaaa.png",
    key: "justice-and-law-enforcement",
  },
  {
    generatedFileName: "exec-457e7307-23ea-4d54-854e-76c4f29b1a86.png",
    key: "economy-and-labor",
  },
  {
    generatedFileName: "exec-bc4b56f5-2119-432c-ad31-9198fd6e20c4.png",
    key: "taxes-and-revenue",
  },
  {
    generatedFileName: "exec-e7008760-e6e2-4f16-b441-91d08e7b3440.png",
    key: "financial-regulation",
  },
  {
    generatedFileName: "exec-3c2c8402-7706-437d-b3ca-0fa2231b64f5.png",
    key: "energy-and-environment",
  },
  {
    generatedFileName: "exec-abbaf88f-a502-478a-894e-f0e828d885ae.png",
    key: "transportation-and-infrastructure",
  },
  {
    generatedFileName: "exec-40942afa-f3c2-438a-887f-e72076619245.png",
    key: "education",
  },
  {
    generatedFileName: "exec-b86b577e-126a-4297-abc5-4db8b6925390.png",
    key: "housing-and-urban-development",
  },
  {
    generatedFileName: "exec-a415cbd2-2591-4b21-bf86-f75703089511.png",
    key: "social-security-and-benefits",
  },
  {
    generatedFileName: "exec-e6a23e6c-2695-4d80-b622-f0aab616540e.png",
    key: "science-and-space",
  },
  {
    generatedFileName: "exec-e8b67b97-2e72-41fd-b032-240d60a9cbe9.png",
    key: "technology-and-cybersecurity",
  },
];
