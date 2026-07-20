export type ReusableImageScope = "agency" | "category";

export interface ReusableImageDefinition {
  altText: string;
  background: "dark" | "light";
  description: string;
  displayName: string;
  imageId: string;
  key: string;
  mood: string;
  scope: ReusableImageScope;
}

const category = (
  definition: Omit<ReusableImageDefinition, "scope">,
): ReusableImageDefinition => ({ ...definition, scope: "category" });

const agency = (
  definition: Omit<ReusableImageDefinition, "scope">,
): ReusableImageDefinition => ({ ...definition, scope: "agency" });

export const REUSABLE_IMAGE_DEFINITIONS: readonly ReusableImageDefinition[] = [
  category({
    altText:
      "Layered paper border gateway with a cobalt path crossing a warm cream landscape and an orange threshold marker.",
    background: "light",
    description:
      "A calm symbolic border gateway, cobalt crossing path, layered landforms, and restrained orange threshold marker.",
    displayName: "Immigration & Border",
    imageId: "1c11e09e-3072-5613-8f17-3208e49b9fb5",
    key: "immigration-and-border",
    mood: "measured, humane, civic",
  }),
  category({
    altText:
      "Charcoal paper canopy shelters cobalt health forms while a small orange marker signals coordinated public care.",
    background: "light",
    description:
      "A protective charcoal canopy sheltering cobalt circular health forms with a small orange public-health marker.",
    displayName: "Public Health",
    imageId: "992a5dbb-d242-5664-8da8-e5a5a37135f5",
    key: "public-health",
    mood: "protective, coordinated, reassuring",
  }),
  category({
    altText:
      "Cream medicine and food vessels pass through cobalt inspection planes beside a precise orange safety wedge.",
    background: "dark",
    description:
      "Blank cream medicine and food vessels moving through layered cobalt inspection planes with an orange safety wedge.",
    displayName: "Food & Drug Safety",
    imageId: "4d238135-f69c-576c-ad42-43986970336f",
    key: "food-and-drug-safety",
    mood: "careful, clean, protective",
  }),
  category({
    altText:
      "Layered charcoal bastion surrounds a cobalt inner field with a small orange readiness marker at its edge.",
    background: "light",
    description:
      "A symbolic layered protective bastion surrounding a cobalt inner field with an orange readiness marker, without weapons.",
    displayName: "Defense & Military",
    imageId: "11e10e54-d7c6-510c-8dab-b94aeeb96bf4",
    key: "defense-and-military",
    mood: "prepared, protective, restrained",
  }),
  category({
    altText:
      "A cobalt paper bridge leads through an open charcoal doorway toward a cream landing supported by orange.",
    background: "light",
    description:
      "A cobalt bridge and open charcoal doorway leading to a sheltered cream landing with an orange support brace.",
    displayName: "Veterans Affairs",
    imageId: "5aa35f67-fe20-5979-84e6-e3ffd7707de5",
    key: "veterans-affairs",
    mood: "supportive, dignified, welcoming",
  }),
  category({
    altText:
      "Balanced cream paper scales rest on a cobalt base with an orange fulcrum against deep charcoal layers.",
    background: "dark",
    description:
      "Balanced abstract cream scales, cobalt structural blocks, and a restrained orange fulcrum on a charcoal field.",
    displayName: "Justice & Law Enforcement",
    imageId: "8e6b4f28-535d-59f6-8ea7-0e8b2681763e",
    key: "justice-and-law-enforcement",
    mood: "balanced, accountable, sober",
  }),
  category({
    altText:
      "Interlocking cobalt paper gears lift a stepped cream platform while an orange piece marks shared economic momentum.",
    background: "light",
    description:
      "Interlocking abstract cobalt gears and a rising cream work platform with one orange momentum marker.",
    displayName: "Economy & Labor",
    imageId: "3bc1af9f-4b54-5612-a006-11184f873d00",
    key: "economy-and-labor",
    mood: "productive, steady, collective",
  }),
  category({
    altText:
      "Blank cream ledger sheets and round revenue tokens flow into an orderly cobalt channel with an orange tab.",
    background: "light",
    description:
      "A compact blank tax ledger and simple round revenue tokens flowing into an orderly cobalt civic channel with an orange tab.",
    displayName: "Taxes & Revenue",
    imageId: "a30b3922-3754-58c1-bcbb-bbb0cbdd6f98",
    key: "taxes-and-revenue",
    mood: "orderly, accountable, public-serving",
  }),
  category({
    altText:
      "Parallel cobalt channels pass through a sturdy cream checkpoint while an orange wedge signals careful financial oversight.",
    background: "dark",
    description:
      "Parallel cobalt financial channels passing through a sturdy cream guardrail and balanced checkpoint with an orange oversight wedge.",
    displayName: "Financial Regulation",
    imageId: "958b2d42-613b-5b34-897f-cb17497b4fff",
    key: "financial-regulation",
    mood: "vigilant, stable, measured",
  }),
  category({
    altText:
      "A cobalt leaf interlocks with a circular energy loop above charcoal landforms and a small orange sun.",
    background: "light",
    description:
      "A bold cobalt leaf interlocked with a simplified circular energy loop above layered charcoal landforms and an orange sun marker.",
    displayName: "Energy & Environment",
    imageId: "0978ac3f-6d3c-5a3b-b9b4-368941e38725",
    key: "energy-and-environment",
    mood: "regenerative, practical, forward-looking",
  }),
  category({
    altText:
      "A sturdy cream bridge crosses layered cobalt routes with one orange support pier against a charcoal field.",
    background: "dark",
    description:
      "A sturdy cream bridge crossing layered cobalt road and rail routes with a single orange support pier.",
    displayName: "Transportation & Infrastructure",
    imageId: "8873dfb0-3b90-5b97-a735-be81ac00fe3f",
    key: "transportation-and-infrastructure",
    mood: "connected, durable, civic",
  }),
  category({
    altText:
      "An open blank paper book rises into cobalt learning steps with a small orange bookmark shape.",
    background: "light",
    description:
      "A large open blank-paper book transforming into stepped cobalt learning blocks with one orange bookmark-like shape.",
    displayName: "Education",
    imageId: "2e5e2f66-f2ca-5227-9a88-1d7151d9ff14",
    key: "education",
    mood: "open, curious, accessible",
  }),
  category({
    altText:
      "A welcoming cobalt roof and doorway rise from cream neighborhood blocks on a steady orange foundation brace.",
    background: "light",
    description:
      "A welcoming cobalt roof and doorway assembled from layered neighborhood blocks, grounded by charcoal streets and an orange foundation brace.",
    displayName: "Housing & Urban Development",
    imageId: "f1ed9379-3829-57d5-b519-7b9100554230",
    key: "housing-and-urban-development",
    mood: "stable, inclusive, community-focused",
  }),
  category({
    altText:
      "A broad cream paper canopy protects cobalt household forms with a single orange pillar against charcoal.",
    background: "dark",
    description:
      "A broad cream sheltering canopy over blank cobalt benefit-card and household forms, supported by one orange pillar.",
    displayName: "Social Security & Benefits",
    imageId: "f14b1705-1c78-5bfc-ad74-602ef181419e",
    key: "social-security-and-benefits",
    mood: "dependable, protective, humane",
  }),
  category({
    altText:
      "A cobalt telescope and orbiting paper circles emerge from charcoal layers beneath a small orange discovery marker.",
    background: "light",
    description:
      "A simplified cobalt telescope aimed toward layered orbiting circles, charcoal ground forms, and a small orange discovery marker.",
    displayName: "Science & Space",
    imageId: "6dfc77a7-7ac1-5041-a01a-ea701262fbb1",
    key: "science-and-space",
    mood: "inquisitive, expansive, exact",
  }),
  category({
    altText:
      "A cobalt circuit grid passes through a cream locked gateway with an orange verification node on charcoal.",
    background: "dark",
    description:
      "An abstract cobalt circuit grid passing through a sturdy cream locked gateway with a restrained orange verification node.",
    displayName: "Technology & Cybersecurity",
    imageId: "ae51fc61-f204-57d8-aecb-010553abcc0b",
    key: "technology-and-cybersecurity",
    mood: "secure, modern, vigilant",
  }),
  category({
    altText:
      "A blank cream ballot form enters an orderly cobalt civic box beside an orange process marker.",
    background: "light",
    description:
      "A blank cream ballot-like form entering an orderly cobalt civic box, surrounded by clean government process channels and an orange marker.",
    displayName: "Elections & Government Operations",
    imageId: "050c34ce-2d4f-5055-8edc-2d7f15d1f7e2",
    key: "elections-and-government-operations",
    mood: "orderly, neutral, participatory",
  }),
  category({
    altText:
      "Layered cobalt trade routes arc between cream globe fragments and a simple orange cargo block.",
    background: "dark",
    description:
      "Layered cobalt global routes arcing between abstract cream land fragments and a simple orange trade cargo block.",
    displayName: "Foreign Affairs & Trade",
    imageId: "a31ba6de-baa3-5221-9891-a74a3e3dbcc8",
    key: "foreign-affairs-and-trade",
    mood: "connected, diplomatic, outward-looking",
  }),
  category({
    altText:
      "A sturdy cobalt shelter stands above layered storm waves with an orange emergency path cutting safely through.",
    background: "dark",
    description:
      "A sturdy cobalt emergency shelter above layered charcoal storm and flood forms with a clear orange response path.",
    displayName: "Disaster Response & Emergency",
    imageId: "18190cab-5f51-5354-a802-3b98d835b987",
    key: "disaster-response-and-emergency",
    mood: "urgent, resilient, coordinated",
  }),
  category({
    altText:
      "Cobalt field rows lead toward a cream grain structure beneath a restrained orange sun on textured paper.",
    background: "light",
    description:
      "Layered cobalt field rows leading toward a simplified cream grain structure beneath a restrained orange sun.",
    displayName: "Agriculture",
    imageId: "08675d45-dffd-5dac-a840-5ba158da7001",
    key: "agriculture",
    mood: "grounded, productive, seasonal",
  }),
  category({
    altText:
      "Two equal cobalt pathways pass through matching cream doorways joined by a bright orange threshold.",
    background: "light",
    description:
      "Two equal cobalt pathways passing through matching open cream doorways, joined by a clear orange threshold of access.",
    displayName: "Civil Rights & Liberties",
    imageId: "3a6332ad-c15f-5049-abdc-f024fea6dcbb",
    key: "civil-rights-and-liberties",
    mood: "equal, open, resolute",
  }),
  category({
    altText:
      "Layered charcoal mountains frame a cobalt river and cream valley with a small orange stewardship marker.",
    background: "light",
    description:
      "Layered charcoal mountain forms framing a cobalt river and cream valley, with a restrained orange stewardship marker.",
    displayName: "Public Lands & Natural Resources",
    imageId: "3e489081-2526-5709-b605-3ddc6a5cbe43",
    key: "public-lands-and-natural-resources",
    mood: "expansive, enduring, stewarded",
  }),
  agency({
    altText:
      "Cobalt measurement bars and round labor markers align on a cream statistical grid with one orange reference tab.",
    background: "light",
    description:
      "Abstract cobalt measurement bars and labor markers aligned on a blank cream statistical grid with one orange reference tab.",
    displayName: "Bureau of Labor Statistics",
    imageId: "738ab9bf-930b-5c81-ba14-36de5beef69a",
    key: "bls",
    mood: "precise, neutral, informative",
  }),
  agency({
    altText:
      "A charcoal protective ring surrounds cobalt health cells while an orange signal marks coordinated disease prevention.",
    background: "light",
    description:
      "A charcoal protective ring surrounding abstract cobalt health cells with an orange surveillance and prevention signal.",
    displayName: "Centers for Disease Control and Prevention",
    imageId: "fdefe874-6222-5ffb-b79b-0e60f9ef6baf",
    key: "cdc",
    mood: "watchful, scientific, protective",
  }),
  agency({
    altText:
      "Cobalt market channels meet a firm cream enforcement gate and orange stop wedge on dark textured paper.",
    background: "dark",
    description:
      "Abstract cobalt commodity channels meeting a firm cream enforcement gate and restrained orange stop wedge.",
    displayName: "Commodity Futures Trading Commission — Enforcement",
    imageId: "5b8e2e65-2c04-5ea7-ae50-7edf4b778679",
    key: "cftc",
    mood: "firm, orderly, vigilant",
  }),
  agency({
    altText:
      "A cobalt infrastructure circuit passes through a cream shielded gateway with an orange alert node on charcoal.",
    background: "dark",
    description:
      "A cobalt infrastructure circuit passing through a sturdy cream shielded gateway with a single orange alert node.",
    displayName: "Cybersecurity and Infrastructure Security Agency",
    imageId: "e7e83a29-b39b-5a91-9a61-3d1e30e90625",
    key: "cisa",
    mood: "resilient, alert, technical",
  }),
  agency({
    altText:
      "Layered cream industrial vessels sit behind a cobalt investigation lens with a precise orange hazard marker.",
    background: "dark",
    description:
      "Simplified cream industrial vessels examined through a cobalt investigation lens with a restrained orange safety marker.",
    displayName: "U.S. Chemical Safety and Hazard Investigation Board",
    imageId: "a2439d24-4ea3-5353-bc62-230618435587",
    key: "csb",
    mood: "forensic, careful, preventive",
  }),
  agency({
    altText:
      "Balanced cream scales stand within cobalt legal columns above an orange fulcrum on a charcoal field.",
    background: "dark",
    description:
      "Balanced cream scales framed by abstract cobalt legal columns and grounded by one orange fulcrum.",
    displayName: "Department of Justice",
    imageId: "3c86ca46-45e7-54c9-b69c-0f8287e50ae9",
    key: "doj",
    mood: "authoritative, balanced, sober",
  }),
  agency({
    altText:
      "Equal cobalt work pathways pass through matching cream gates joined by an orange access bridge.",
    background: "light",
    description:
      "Equal cobalt workplace pathways passing through matching cream opportunity gates joined by an orange access bridge.",
    displayName: "Equal Employment Opportunity Commission",
    imageId: "1e77201d-f4e7-57d4-ba04-2d1fb5880e8d",
    key: "eeoc",
    mood: "fair, accessible, resolute",
  }),
  agency({
    altText:
      "A cobalt leaf and clean water arc rest inside a cream protective ring with an orange indicator.",
    background: "light",
    description:
      "A cobalt leaf and clean-water arc contained within a cream protective ring with a small orange environmental indicator.",
    displayName: "Environmental Protection Agency",
    imageId: "05a976f4-a1c9-5dce-ab5a-01533480e320",
    key: "epa",
    mood: "protective, restorative, practical",
  }),
  agency({
    altText:
      "Blank cream medicine and food forms pass through cobalt inspection bands beside an orange safety marker.",
    background: "dark",
    description:
      "Blank cream medicine and food forms moving through precise cobalt inspection bands beside an orange safety marker.",
    displayName: "Food and Drug Administration",
    imageId: "5ae3510e-173b-5983-b556-b7950ce757f9",
    key: "fda",
    mood: "careful, clinical, protective",
  }),
  agency({
    altText:
      "A sturdy cobalt emergency shelter rises above charcoal flood layers with a clear orange response route.",
    background: "dark",
    description:
      "A sturdy cobalt emergency shelter above charcoal flood and storm layers with a clear orange response route.",
    displayName: "Federal Emergency Management Agency",
    imageId: "a4ce0f36-c6bf-5d9b-929d-8c6ce344ec38",
    key: "fema",
    mood: "ready, resilient, coordinated",
  }),
  agency({
    altText:
      "Blank cream aid forms rise along cobalt education steps supported by a small orange bridge shape.",
    background: "light",
    description:
      "Blank cream student-aid forms rising along cobalt education steps supported by a small orange bridge shape.",
    displayName: "Federal Student Aid",
    imageId: "b620f78c-eea3-59f4-b54d-71886d4f3a8e",
    key: "fsa",
    mood: "supportive, accessible, hopeful",
  }),
  agency({
    altText:
      "Cobalt marketplace blocks pass through a cream fairness checkpoint with an orange consumer protection wedge.",
    background: "light",
    description:
      "Abstract cobalt marketplace blocks passing through a cream fairness checkpoint with an orange consumer-protection wedge.",
    displayName: "Federal Trade Commission",
    imageId: "43e3b566-64d0-52f8-836a-bcab2722decc",
    key: "ftc",
    mood: "watchful, fair, practical",
  }),
  agency({
    altText:
      "Layered charcoal forest ridges surround a cobalt fire perimeter crossed by one orange incident path.",
    background: "dark",
    description:
      "Layered charcoal forest ridges surrounding a cobalt incident perimeter and one controlled orange response path.",
    displayName: "NIFC InciWeb",
    imageId: "a5fb1af2-40b3-58a7-b789-d38eb5ee8237",
    key: "inciweb",
    mood: "urgent, mapped, coordinated",
  }),
  agency({
    altText:
      "Blank cream tax forms and round tokens enter a cobalt processing channel marked by an orange tab.",
    background: "light",
    description:
      "Blank cream tax forms and simple round revenue tokens entering a cobalt processing channel marked by an orange tab.",
    displayName: "Internal Revenue Service",
    imageId: "1038313c-f6d4-5f9e-bd08-02a15baa6a88",
    key: "irs",
    mood: "orderly, official, measured",
  }),
  agency({
    altText:
      "A cobalt orbital craft arcs around cream planetary forms with a small orange discovery signal.",
    background: "dark",
    description:
      "A simplified cobalt orbital craft and sweeping orbit around abstract cream planetary forms with an orange discovery signal.",
    displayName: "National Aeronautics and Space Administration",
    imageId: "ec35b4b9-73cd-57a1-826c-2a787d3ebafd",
    key: "nasa",
    mood: "exploratory, exact, expansive",
  }),
  agency({
    altText:
      "Cobalt biological strands connect cream research tiles beneath an orange discovery node on textured paper.",
    background: "light",
    description:
      "Abstract cobalt biological strands connecting blank cream research tiles beneath a restrained orange discovery node.",
    displayName: "National Center for Biotechnology Information",
    imageId: "8cb47399-9194-58c0-a255-d3a4d7db008e",
    key: "ncbi",
    mood: "scientific, connected, precise",
  }),
  agency({
    altText:
      "Layered cobalt ocean waves meet cream atmospheric arcs beneath a small orange observation marker.",
    background: "light",
    description:
      "Layered cobalt ocean waves meeting broad cream atmospheric arcs beneath a small orange observation marker.",
    displayName: "National Oceanic and Atmospheric Administration",
    imageId: "9f652314-cd4e-5d20-b37f-d26661081ff9",
    key: "noaa",
    mood: "observant, expansive, scientific",
  }),
  agency({
    altText:
      "Charcoal mountain layers frame a cobalt trail and cream valley beside an orange stewardship marker.",
    background: "light",
    description:
      "Charcoal mountain layers framing a cobalt public trail and cream valley beside a restrained orange stewardship marker.",
    displayName: "National Park Service",
    imageId: "6629ac0d-5260-5409-8843-14ad2b4e858c",
    key: "nps",
    mood: "welcoming, enduring, stewarded",
  }),
  agency({
    altText:
      "Cobalt transport paths converge beneath a cream investigation lens with a precise orange evidence marker.",
    background: "dark",
    description:
      "Abstract cobalt transport paths converging beneath a cream investigation lens with a precise orange evidence marker.",
    displayName: "National Transportation Safety Board",
    imageId: "22b72b23-3ca9-5a2e-a003-052f22bac38d",
    key: "ntsb",
    mood: "forensic, independent, careful",
  }),
  agency({
    altText:
      "Layered cobalt cloud bands cross a cream horizon while an orange warning beam marks changing weather.",
    background: "dark",
    description:
      "Layered cobalt cloud and wind bands crossing a cream horizon with one clear orange warning beam.",
    displayName: "National Weather Service",
    imageId: "85fde2cc-7f80-5faf-bed3-7c23c8e724df",
    key: "nws",
    mood: "alert, clear, watchful",
  }),
  agency({
    altText:
      "A cream protective barrier surrounds cobalt work tools with an orange safety wedge on charcoal paper.",
    background: "dark",
    description:
      "A sturdy cream protective barrier surrounding abstract cobalt workplace tools with an orange safety wedge.",
    displayName: "Occupational Safety and Health Administration",
    imageId: "6f2d4304-2f06-5ad5-b155-66fad11a7c63",
    key: "osha",
    mood: "protective, practical, firm",
  }),
  agency({
    altText:
      "Cobalt market columns pass through a balanced cream oversight frame with an orange verification marker.",
    background: "light",
    description:
      "Abstract cobalt market columns passing through a balanced cream oversight frame with an orange verification marker.",
    displayName: "Securities and Exchange Commission",
    imageId: "27c85c0e-a3bc-57c9-aecc-8c5ca2e04063",
    key: "sec",
    mood: "stable, transparent, watchful",
  }),
  agency({
    altText:
      "Cobalt market blocks meet a firm cream enforcement gate with an orange stop wedge on charcoal.",
    background: "dark",
    description:
      "Abstract cobalt market blocks meeting a firm cream enforcement gate and a restrained orange stop wedge.",
    displayName: "Securities and Exchange Commission — Enforcement",
    imageId: "167dea6a-b349-5c21-9029-acf0060e4d47",
    key: "sec-enforcement",
    mood: "firm, exact, accountable",
  }),
  agency({
    altText:
      "A broad cream canopy protects cobalt household and benefit forms supported by an orange pillar.",
    background: "dark",
    description:
      "A broad cream canopy protecting blank cobalt household and benefit forms, supported by one orange pillar.",
    displayName: "Social Security Administration",
    imageId: "37169e5c-6f58-5b99-9c26-864aef1a1bd9",
    key: "ssa",
    mood: "dependable, humane, steady",
  }),
  agency({
    altText:
      "Cobalt diplomatic routes connect cream global forms around a restrained orange meeting point on charcoal.",
    background: "dark",
    description:
      "Cobalt diplomatic routes connecting abstract cream global forms around a restrained orange meeting point.",
    displayName: "Department of State",
    imageId: "63125814-8417-5c4e-b27f-0ab58c2878ff",
    key: "state",
    mood: "diplomatic, connected, composed",
  }),
  agency({
    altText:
      "A cobalt regional shelter stands above charcoal storm layers beside a clear orange incident route.",
    background: "dark",
    description:
      "A cobalt regional incident shelter above charcoal storm layers with a clear orange coordination route.",
    displayName: "Office of the Texas Governor — Incident Response",
    imageId: "f34eb078-9641-50b3-af30-eedb2cc44651",
    key: "texas-gov",
    mood: "regional, ready, coordinated",
  }),
  agency({
    altText:
      "Cream public ledgers and round tokens rest within a sturdy cobalt treasury vault and orange brace.",
    background: "light",
    description:
      "Blank cream public ledgers and simple round tokens held within a sturdy cobalt treasury vault and orange brace.",
    displayName: "Department of the Treasury",
    imageId: "d9e10028-169b-5a1e-814b-464783afcc55",
    key: "treasury",
    mood: "stable, accountable, institutional",
  }),
  agency({
    altText:
      "A cobalt pathway crosses a cream eligibility gateway with an orange welcome marker on layered paper.",
    background: "light",
    description:
      "A cobalt civic pathway crossing a cream eligibility and welcome gateway with a restrained orange threshold marker.",
    displayName: "U.S. Citizenship and Immigration Services",
    imageId: "6a8f3626-ea26-5221-9b20-a1770ff8647e",
    key: "uscis",
    mood: "welcoming, orderly, humane",
  }),
  agency({
    altText:
      "Cobalt field rows lead to cream farm forms beneath an orange sun on warm textured paper.",
    background: "light",
    description:
      "Layered cobalt field rows leading toward simplified cream farm forms beneath a restrained orange sun.",
    displayName: "Department of Agriculture",
    imageId: "8ce50fb9-2267-5467-855b-1fe14f6d1130",
    key: "usda",
    mood: "productive, grounded, sustaining",
  }),
  agency({
    altText:
      "Layered charcoal earth strata reveal cobalt mineral forms beside an orange survey marker on cream.",
    background: "light",
    description:
      "Layered charcoal earth strata revealing cobalt mineral and water forms beside a restrained orange survey marker.",
    displayName: "U.S. Geological Survey",
    imageId: "e50f0322-434a-5733-8159-077a909a9597",
    key: "usgs",
    mood: "observant, grounded, scientific",
  }),
  agency({
    altText:
      "A blank cream parcel travels through a cobalt delivery network marked by one orange route tab.",
    background: "light",
    description:
      "A blank cream parcel moving through an orderly cobalt delivery network marked by one orange route tab.",
    displayName: "United States Postal Service",
    imageId: "718e59f0-7542-504c-8d54-e616a93399ed",
    key: "usps",
    mood: "connected, dependable, everyday",
  }),
  agency({
    altText:
      "A cobalt support bridge leads toward a sheltered cream doorway held by a strong orange brace.",
    background: "light",
    description:
      "A cobalt support bridge leading toward a sheltered cream care doorway held by a strong orange brace.",
    displayName: "Department of Veterans Affairs",
    imageId: "2e13771d-4601-583f-b9a6-14bebbd8bcf9",
    key: "va",
    mood: "supportive, dignified, steady",
  }),
] as const;

export function reusableImageByKey(
  key: string,
): ReusableImageDefinition | undefined {
  return REUSABLE_IMAGE_DEFINITIONS.find(
    (definition) => definition.key === key,
  );
}

const BASE_PROMPT = `Use case: stylized-concept
Asset type: reusable 1536 x 1024 landscape fallback thumbnail for a U.S. public-interest news dashboard
Input images: Images 1, 2, and 3 are style and material references only. Do not copy their exact subjects or layouts.
Style and medium: tactile hand-cut editorial paper collage with roughly 7–10 layered torn-paper shapes, visible fibers, subtle halftone and newsprint texture, crisp analog cut edges, flat matte materials.
Composition: 3:2 landscape. Keep the meaningful subject inside the central 65% so both a 1200x480 card crop and 1200x630 social crop remain readable. Strong simple silhouette, generous negative space, editorial rather than decorative.
Palette: warm cream paper, charcoal and deep brown-black, cobalt blue focal forms, restrained signal-orange accent.
Hard constraints: no text, letters, numbers, logos, seals, flags, identifiable people, faces, watermarks, photorealism, glossy 3D, gradients, stock-photo look, decorative borders, or tiny intricate details.`;

export function generationPrompt(definition: ReusableImageDefinition): string {
  return `${BASE_PROMPT}
Primary request: Create the ${definition.scope} image for “${definition.displayName}.”
Scene and subject: on a ${definition.background === "dark" ? "deep charcoal" : "warm cream"} field, ${definition.description.charAt(0).toLowerCase()}${definition.description.slice(1)}
Mood: ${definition.mood}.`;
}
