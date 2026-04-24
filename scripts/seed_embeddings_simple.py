"""Seed embeddings via agent-api + Railway Postgres SQL console.

This script:
  1. Calls agent-api /v1/embeddings to generate vectors
  2. Prints UPDATE SQL statements you paste into Railway's SQL console

No database driver needed locally — just httpx.

Usage (Windows cmd):
    pip install httpx
    set AGENT_API_URL=https://your-agent-api-url.up.railway.app
    python scripts/seed_embeddings_simple.py
"""

import httpx
import json
import sys
import os

AGENT_API_URL = os.environ.get("AGENT_API_URL", "").rstrip("/")

# The seed data from 004_seed.sql — vehicle descriptions
VEHICLE_DESCRIPTIONS = [
    ("1HGCG5655WA042867", "Brand new 2024 Toyota Camry XSE in Midnight Black with red leather interior. Sporty and refined with a panoramic sunroof and full safety suite."),
    ("2T1BURHE8JC987654", "Low-mileage 2023 Toyota RAV4 XLE Premium in Blueprint blue. All-wheel drive, heated seats, panoramic sunroof. Perfect for families."),
    ("5YFBURHE2JP123456", "All-new 2024 Honda Civic Sport Touring in Rallye Red. Turbocharged, premium Bose sound system, and the full Honda Sensing safety suite."),
    ("1G1YY22G575100001", "Rugged 2023 Ford F-150 Lariat in Iconic Silver. 4WD with the towing package, leather interior, and Bang & Olufsen premium audio."),
    ("WVWZZZ3CZWE654321", "Sharp 2024 Chevrolet Equinox RS in Sterling Gray. Turbocharged with all-wheel drive, panoramic sunroof, and the latest Chevy Safety Assist."),
    ("JN1TBNT30Z0000001", "Elegant 2023 Nissan Altima SL in Pearl White with tan leather. ProPILOT Assist semi-autonomous driving and premium Bose audio."),
    ("1FMCU9J98NUA00001", "Eco-friendly 2024 Ford Escape ST-Line Hybrid in Vapor Blue. All-wheel drive with Fords Co-Pilot360 driver assist and SYNC 4 infotainment."),
    ("3MW5R1J00M8B00001", "Certified pre-owned 2023 BMW 330i M Sport in Alpine White. Remaining factory warranty, Harman Kardon audio, heads-up display."),
    ("5YJ3E1EA8LF000001", "Sleek 2023 Tesla Model 3 Long Range in Solid Black. 358-mile EPA range, Autopilot included, premium white interior with the expansive glass roof."),
    ("1C4RJFBG0LC000001", "Commanding 2024 Jeep Grand Cherokee Limited in Diamond Black. 4x4 with adaptive air suspension, McIntosh premium audio, and night vision camera."),
    ("KMHD84LF2MU000001", "Value-packed 2024 Hyundai Elantra SEL in Intense Blue. Full SmartSense safety, wireless Apple CarPlay, and heated front seats at an unbeatable price."),
    ("5NMS3DAJ0PH000001", "Premium 2024 Hyundai Santa Fe Calligraphy Hybrid in Hampton Gray. HTRAC all-wheel drive, Nappa leather, surround-view camera system."),
    ("WA1LAAF70ND000001", "Certified pre-owned 2023 Audi Q5 Premium Plus in Navarra Blue. Quattro all-wheel drive, virtual cockpit, Bang and Olufsen 3D sound system."),
    ("1G1FE1R70L0000001", "Thrilling 2023 Chevrolet Camaro LT1 in Red Hot. 6.2L V8 with 455 horsepower, 6-speed manual, Brembo brakes, and dual-mode performance exhaust."),
    ("JTDKN3DU5A0000001", "Ultra-efficient 2024 Toyota Prius XLE in Wind Chill Pearl. All-wheel drive hybrid with 57 MPG combined, the latest Safety Sense 3.0, and a gorgeous 12.3-inch display."),
    ("3N1AB8CV0LY000001", "Versatile 2024 Nissan Rogue SV in Super Black. All-wheel drive, ProPILOT Assist, panoramic moonroof, and the flexible Divide-N-Hide cargo system."),
    ("1GKKNXLS0MZ000001", "Luxury truck: 2023 GMC Sierra 1500 Denali in Onyx Black. Full Denali Ultimate package, CarbonPro composite bed, and hands-free Super Cruise highway driving."),
    ("WBAPH5C55BA000001", "Sporty 2024 BMW X3 xDrive30i in Phytonic Blue with cognac leather. Turbocharged, all-wheel drive, panoramic roof, and full parking assistant."),
    ("KM8R3DHE5LU000001", "Award-winning 2024 Kia Telluride SX in Everlasting Silver. Three-row seating with second-row captain chairs, premium Harman Kardon audio, and Highway Driving Assist 2."),
    ("SALGS2RE3LA000001", "Efficient and capable: 2024 Honda CR-V Sport Touring Hybrid in Canyon River Blue. 40 MPG combined with AWD, Bose premium audio, and the latest Honda Sensing 2.0."),
]

# Knowledge base content from 004_seed.sql
KNOWLEDGE_CHUNKS = [
    "Our dealership is open Monday through Saturday, 9 AM to 8 PM, and Sunday from 11 AM to 5 PM. We are closed on major holidays including New Year's Day, Thanksgiving, and Christmas.",
    "We are located at 1234 Auto Mall Drive, Springfield, IL 62701. We have ample free parking and are easily accessible from Interstate 55.",
    "You can reach our sales team at 555-AUTO-DEAL (555-288-6332) during business hours, or leave a message and we will call you back within one business day.",
    "We offer complimentary test drives on all vehicles in our inventory. No appointment is necessary during business hours, but we recommend scheduling ahead for weekends. You must bring a valid driver's license. Test drives typically last 15 to 20 minutes.",
    "We accept trade-ins on all purchases. Bring your vehicle along with the title or payoff information and we will provide a competitive written offer on the spot. Our appraisal uses Kelley Blue Book and real-time auction data. Trade-in offers are valid for 7 days.",
    "We offer a 5-day, 250-mile money-back guarantee on all used and certified pre-owned vehicles. If you are not completely satisfied, return the vehicle in the same condition and we will issue a full refund minus a $250 restocking fee. New vehicles are not eligible for the money-back guarantee but are covered under manufacturer warranty.",
    "All new vehicles come with the full manufacturer warranty. Certified pre-owned vehicles include an extended powertrain warranty of 5 years or 100,000 miles from the original in-service date. Used vehicles are sold as-is unless you purchase our optional extended warranty, which covers major components for up to 3 years.",
    "We work with over 20 lending partners to find the best rate for your situation. Most customers qualify for financing with APR starting as low as 2.9% for 60 months on new vehicles and 4.9% on pre-owned. We can pre-qualify you with a soft credit check that does not affect your credit score. Full approval requires a hard inquiry.",
    "We accept all forms of payment: cash, personal check, cashier's check, bank wire, and financing through our lending partners or your own bank. For purchases over $10,000 in cash, federal regulations require us to file a Currency Transaction Report. Down payments as low as $0 are available for qualified buyers.",
    "Our lease specials change monthly. Current offers include 36-month leases on select models with $2,999 due at signing. Lease-end options include purchase at residual value, return, or trade up to a newer model. Mileage limits are typically 10,000 or 12,000 miles per year, with excess mileage charged at $0.20 per mile.",
    "Our service department is open Monday through Friday, 7 AM to 6 PM, and Saturday from 8 AM to 2 PM. We service all makes and models, not just the brands we sell. Online appointment booking is available at our website. Oil changes start at $39.99 and include a complimentary multi-point inspection.",
    "We offer complimentary shuttle service within a 15-mile radius and loaner vehicles for repairs expected to take more than 4 hours. Our waiting area features free Wi-Fi, coffee, and a children's play area.",
    "Spring Sale Event: Get up to $3,000 off MSRP on all 2024 models in stock, plus 0% APR for 48 months on select new Toyota, Honda, and Hyundai models. Offer valid through June 30th. Cannot be combined with other offers. See dealer for details.",
    "First Responder and Military Discount: We offer an additional $500 off any vehicle purchase for active military, veterans, police officers, firefighters, and EMTs. Bring valid ID or proof of service.",
    "Referral Program: Refer a friend who purchases a vehicle and you both receive a $250 gift card. There is no limit on the number of referrals. Ask your sales representative for a referral card.",
]


def embed_texts(texts):
    """Call agent-api to embed a batch of texts."""
    resp = httpx.post(
        f"{AGENT_API_URL}/v1/embeddings",
        json={"texts": texts, "cache": False},
        timeout=120,
    )
    if resp.status_code != 200:
        print(f"ERROR: {resp.status_code} — {resp.text[:300]}")
        sys.exit(1)
    return resp.json()["embeddings"]


def vector_to_sql(vec):
    """Format a vector as a Postgres array literal."""
    return "'[" + ",".join(f"{v:.8f}" for v in vec) + "]'"


def main():
    if not AGENT_API_URL:
        print("ERROR: Set AGENT_API_URL environment variable first.")
        print("  Windows cmd:  set AGENT_API_URL=https://your-agent-api.up.railway.app")
        print("  PowerShell:   $env:AGENT_API_URL=\"https://your-agent-api.up.railway.app\"")
        sys.exit(1)

    print(f"Using agent-api at: {AGENT_API_URL}")
    print()

    # ── Embed vehicles ──
    print(f"Embedding {len(VEHICLE_DESCRIPTIONS)} vehicle descriptions...")
    vehicle_texts = [desc for _, desc in VEHICLE_DESCRIPTIONS]
    vehicle_vecs = embed_texts(vehicle_texts)
    print(f"  Got {len(vehicle_vecs)} vectors, {len(vehicle_vecs[0])} dims each")

    # ── Embed knowledge chunks ──
    print(f"Embedding {len(KNOWLEDGE_CHUNKS)} knowledge chunks...")
    chunk_vecs = embed_texts(KNOWLEDGE_CHUNKS)
    print(f"  Got {len(chunk_vecs)} vectors, {len(chunk_vecs[0])} dims each")

    # ── Write SQL file ──
    output_file = "seed_embeddings.sql"
    with open(output_file, "w") as f:
        f.write("-- Auto-generated embedding updates. Paste into Railway SQL console.\n\n")

        for (vin, _), vec in zip(VEHICLE_DESCRIPTIONS, vehicle_vecs):
            f.write(f"UPDATE vehicles SET embedding = {vector_to_sql(vec)}::vector WHERE vin = '{vin}';\n")

        f.write("\n-- Knowledge chunks (matched by content prefix)\n\n")
        for content, vec in zip(KNOWLEDGE_CHUNKS, chunk_vecs):
            # Match by first 60 chars to avoid quoting issues
            safe_prefix = content[:60].replace("'", "''")
            f.write(f"UPDATE knowledge_chunks SET embedding = {vector_to_sql(vec)}::vector WHERE content LIKE '{safe_prefix}%';\n")

    print()
    print(f"Done! Generated {output_file}")
    print()
    print("Next steps:")
    print(f"  1. Open {output_file} (it's in your current folder)")
    print("  2. Open Railway SQL console (click Postgres tile -> Data tab)")
    print("  3. Copy-paste the VEHICLE section and run it")
    print("  4. Copy-paste the KNOWLEDGE CHUNKS section and run it")
    print("  5. Verify: SELECT COUNT(*) FROM vehicles WHERE embedding IS NOT NULL;")
    print("     Should return 20")


if __name__ == "__main__":
    main()
