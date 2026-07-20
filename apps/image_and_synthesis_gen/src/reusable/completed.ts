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
  {
    generatedFileName: "exec-5dc57e31-4d90-410b-8853-2b9b18779238.png",
    key: "eeoc",
  },
  {
    generatedFileName: "exec-eb242def-beae-4106-86be-8c889b005e10.png",
    key: "epa",
  },
  {
    generatedFileName: "exec-6345ae4b-136a-4d2a-8bff-83b2b0c63865.png",
    key: "fda",
  },
  {
    generatedFileName: "exec-68bd3301-fab8-46a3-a11c-583e1f274a80.png",
    key: "nps",
  },
  {
    generatedFileName: "exec-287f21f0-ad71-4956-9aad-5dbe914ad032.png",
    key: "ntsb",
  },
  {
    generatedFileName: "exec-ea7ae4ff-e294-4684-a563-8874367fe38f.png",
    key: "nws",
  },
  {
    generatedFileName: "exec-e5152807-f163-4fb0-a200-15d63e38dbae.png",
    key: "elections-and-government-operations",
  },
  {
    generatedFileName: "exec-d331362b-1dca-42b2-b600-4e0e47a429da.png",
    key: "foreign-affairs-and-trade",
  },
  {
    generatedFileName: "exec-59b8f0e8-7b0c-4729-8e6f-c1ef754c6eb2.png",
    key: "disaster-response-and-emergency",
  },
  {
    generatedFileName: "exec-29bd1418-677d-43b3-86f5-914064cca7d1.png",
    key: "agriculture",
  },
  {
    generatedFileName: "exec-e2548eed-06f7-4fea-8e44-0582dd7d1ca9.png",
    key: "civil-rights-and-liberties",
  },
  {
    generatedFileName: "exec-f5bf09f3-7726-43f4-b4fe-231db3bfbbd2.png",
    key: "public-lands-and-natural-resources",
  },
  {
    generatedFileName: "exec-d3b59e8a-931c-4fa0-8b6f-b6e56de9adb6.png",
    key: "fema",
  },
  {
    generatedFileName: "exec-4707b0d3-5027-4edc-864c-5e2b9b41bf6f.png",
    key: "fsa",
  },
  {
    generatedFileName: "exec-de7e0192-693f-4c8b-8456-a03be69588d3.png",
    key: "ftc",
  },
  {
    generatedFileName: "exec-4387e730-0b2c-4055-b577-e34285367608.png",
    key: "osha",
  },
  {
    generatedFileName: "exec-7b220deb-35f6-47f8-b05a-610ded5f37fc.png",
    key: "sec",
  },
  {
    generatedFileName: "exec-83bff146-615d-4f0d-b42a-f8617d49cbc0.png",
    key: "sec-enforcement",
  },
  {
    generatedFileName: "exec-684559f6-38f7-4e6d-8114-2df2dc8b8369.png",
    key: "inciweb",
  },
  {
    generatedFileName: "exec-80a98087-776a-4c7b-bbdd-7193e927a788.png",
    key: "irs",
  },
  {
    generatedFileName: "exec-ee9f5159-c3f8-42a5-891f-0ddc52b1187e.png",
    key: "nasa",
  },
  {
    generatedFileName: "exec-03b24d90-2f03-41e3-addc-19b2dd5342d6.png",
    key: "ssa",
  },
  {
    generatedFileName: "exec-4b026110-a69c-4917-9444-39d28dea509e.png",
    key: "state",
  },
  {
    generatedFileName: "exec-a97491da-6f5e-4a0c-90c1-b1c120eca947.png",
    key: "texas-gov",
  },
  {
    generatedFileName: "exec-664aec2a-1999-4b2f-816c-9fc5b85fb09f.png",
    key: "ncbi",
  },
  {
    generatedFileName: "exec-eb4b99a7-145d-40fd-81ef-d81e9caabf33.png",
    key: "noaa",
  },
  {
    generatedFileName: "exec-0e990bcb-8eac-40a6-ab6a-b02143d21188.png",
    key: "bls",
  },
  {
    generatedFileName: "exec-9880c625-5dce-42bc-bc09-8f21a5915615.png",
    key: "cdc",
  },
  {
    generatedFileName: "exec-fc03594b-ef15-4596-8922-42bd0f320d2b.png",
    key: "cftc",
  },
  {
    generatedFileName: "exec-6c8ff7b2-a7c3-4b02-971d-47d3c9bd2590.png",
    key: "cisa",
  },
  {
    generatedFileName: "exec-ed1771ff-b567-4126-b62b-85d27599b974.png",
    key: "csb",
  },
  {
    generatedFileName: "exec-a8993fba-a2c6-4c0d-9ca8-1300379f507e.png",
    key: "doj",
  },
  {
    generatedFileName: "exec-3a966e18-5710-4dfc-85d4-f469f0e5864e.png",
    key: "treasury",
  },
  {
    generatedFileName: "exec-9afdcf77-e318-4a33-9abf-72546cf666dd.png",
    key: "uscis",
  },
  {
    generatedFileName: "exec-f690b152-6c28-4ccc-b927-18cbfd786a24.png",
    key: "usda",
  },
  {
    generatedFileName: "exec-e4fe7350-4bc3-4a32-ba8b-c6e1770294df.png",
    key: "usgs",
  },
  {
    generatedFileName: "exec-38dee9da-ee15-4993-b6f3-b110317b57f2.png",
    key: "usps",
  },
  {
    generatedFileName: "exec-aa095b5a-7ab4-4172-9cf0-5bc5e54b1a91.png",
    key: "va",
  },
];
