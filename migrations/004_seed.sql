-- 004_seed.sql — Sample inventory + FAQ knowledge base
--
-- Run AFTER 003_indexes.sql:
--   psql $DATABASE_URL -f migrations/004_seed.sql
--
-- This gives us enough data to test Voice-to-SQL and RAG.
-- Embeddings are NULL initially — the embedding job (or agent-api on first use)
-- will populate them via OpenAI text-embedding-3-small.
--
-- SAFE TO RE-RUN: uses ON CONFLICT DO NOTHING on VIN / content.

-- ════════════════════════════════════════════
-- VEHICLES (20 diverse entries)
-- ════════════════════════════════════════════

INSERT INTO vehicles (vin, make, model, year, trim, color_ext, color_int, mileage, price, condition, transmission, fuel_type, body_style, features, status, description)
VALUES
  ('1HGCG5655WA042867', 'Toyota', 'Camry', 2024, 'XSE', 'Midnight Black', 'Red Leather', 12, 32995.00, 'new', 'Automatic', 'Gasoline', 'Sedan', '["Apple CarPlay","Android Auto","Blind Spot Monitor","Sunroof","Lane Departure Alert"]', 'available',
   'Brand new 2024 Toyota Camry XSE in Midnight Black with red leather interior. Sporty and refined with a panoramic sunroof and full safety suite.'),

  ('2T1BURHE8JC987654', 'Toyota', 'RAV4', 2023, 'XLE Premium', 'Blueprint', 'Black', 15200, 34500.00, 'used', 'Automatic', 'Gasoline', 'SUV', '["AWD","Sunroof","Heated Seats","Apple CarPlay","Backup Camera"]', 'available',
   'Low-mileage 2023 Toyota RAV4 XLE Premium in Blueprint blue. All-wheel drive, heated seats, panoramic sunroof. Perfect for families.'),

  ('5YFBURHE2JP123456', 'Honda', 'Civic', 2024, 'Sport Touring', 'Rallye Red', 'Black', 0, 30750.00, 'new', 'CVT', 'Gasoline', 'Sedan', '["Turbo","Bose Audio","Wireless CarPlay","Honda Sensing","Heated Seats"]', 'available',
   'All-new 2024 Honda Civic Sport Touring in Rallye Red. Turbocharged, premium Bose sound system, and the full Honda Sensing safety suite.'),

  ('1G1YY22G575100001', 'Ford', 'F-150', 2023, 'Lariat', 'Iconic Silver', 'Black', 22000, 48900.00, 'used', 'Automatic', 'Gasoline', 'Truck', '["4WD","Towing Package","Leather","B&O Sound","Tailgate Step","360 Camera"]', 'available',
   'Rugged 2023 Ford F-150 Lariat in Iconic Silver. 4WD with the towing package, leather interior, and Bang & Olufsen premium audio.'),

  ('WVWZZZ3CZWE654321', 'Chevrolet', 'Equinox', 2024, 'RS', 'Sterling Gray', 'Jet Black', 5, 33200.00, 'new', 'Automatic', 'Gasoline', 'SUV', '["Turbo","AWD","Panoramic Roof","Wireless Charging","Chevy Safety Assist"]', 'available',
   'Sharp 2024 Chevrolet Equinox RS in Sterling Gray. Turbocharged with all-wheel drive, panoramic sunroof, and the latest Chevy Safety Assist.'),

  ('JN1TBNT30Z0000001', 'Nissan', 'Altima', 2023, 'SL', 'Pearl White', 'Tan Leather', 18500, 27800.00, 'used', 'CVT', 'Gasoline', 'Sedan', '["Leather","ProPILOT Assist","Bose Audio","Heated Seats","Remote Start"]', 'available',
   'Elegant 2023 Nissan Altima SL in Pearl White with tan leather. ProPILOT Assist semi-autonomous driving and premium Bose audio.'),

  ('1FMCU9J98NUA00001', 'Ford', 'Escape', 2024, 'ST-Line', 'Vapor Blue', 'Ebony', 0, 35400.00, 'new', 'Automatic', 'Hybrid', 'SUV', '["Hybrid","AWD","SYNC 4","Co-Pilot360","Heated Steering Wheel"]', 'available',
   'Eco-friendly 2024 Ford Escape ST-Line Hybrid in Vapor Blue. All-wheel drive with Fords Co-Pilot360 driver assist and SYNC 4 infotainment.'),

  ('3MW5R1J00M8B00001', 'BMW', '330i', 2023, 'M Sport', 'Alpine White', 'Black Vernasca', 14000, 42500.00, 'cpo', 'Automatic', 'Gasoline', 'Sedan', '["M Sport Package","Navigation","Harman Kardon","Parking Assistant","Live Cockpit Pro"]', 'available',
   'Certified pre-owned 2023 BMW 330i M Sport in Alpine White. Remaining factory warranty, Harman Kardon audio, heads-up display.'),

  ('5YJ3E1EA8LF000001', 'Tesla', 'Model 3', 2023, 'Long Range', 'Solid Black', 'White', 21000, 35900.00, 'used', 'Automatic', 'Electric', 'Sedan', '["Autopilot","Premium Interior","Glass Roof","15-inch Touchscreen","Supercharger Access"]', 'available',
   'Sleek 2023 Tesla Model 3 Long Range in Solid Black. 358-mile EPA range, Autopilot included, premium white interior with the expansive glass roof.'),

  ('1C4RJFBG0LC000001', 'Jeep', 'Grand Cherokee', 2024, 'Limited', 'Diamond Black', 'Global Black', 3200, 52700.00, 'new', 'Automatic', 'Gasoline', 'SUV', '["4x4","Air Suspension","McIntosh Audio","Night Vision","Panoramic Roof"]', 'available',
   'Commanding 2024 Jeep Grand Cherokee Limited in Diamond Black. 4x4 with adaptive air suspension, McIntosh premium audio, and night vision camera.'),

  ('KMHD84LF2MU000001', 'Hyundai', 'Elantra', 2024, 'SEL', 'Intense Blue', 'Gray', 0, 24800.00, 'new', 'CVT', 'Gasoline', 'Sedan', '["SmartSense","Wireless CarPlay","Heated Seats","LED Headlights","Blind Spot"]', 'available',
   'Value-packed 2024 Hyundai Elantra SEL in Intense Blue. Full SmartSense safety, wireless Apple CarPlay, and heated front seats at an unbeatable price.'),

  ('5NMS3DAJ0PH000001', 'Hyundai', 'Santa Fe', 2024, 'Calligraphy', 'Hampton Gray', 'Rust Brown', 1500, 45600.00, 'new', 'Automatic', 'Hybrid', 'SUV', '["Hybrid","AWD","Nappa Leather","HTRAC","Surround View","Blind Spot"]', 'available',
   'Premium 2024 Hyundai Santa Fe Calligraphy Hybrid in Hampton Gray. HTRAC all-wheel drive, Nappa leather, surround-view camera system.'),

  ('WA1LAAF70ND000001', 'Audi', 'Q5', 2023, 'Premium Plus', 'Navarra Blue', 'Rock Gray', 19500, 46200.00, 'cpo', 'Automatic', 'Gasoline', 'SUV', '["Quattro AWD","Virtual Cockpit","B&O Audio","Panoramic Roof","Matrix LED"]', 'available',
   'Certified pre-owned 2023 Audi Q5 Premium Plus in Navarra Blue. Quattro all-wheel drive, virtual cockpit, Bang & Olufsen 3D sound system.'),

  ('1G1FE1R70L0000001', 'Chevrolet', 'Camaro', 2023, 'LT1', 'Red Hot', 'Jet Black', 8500, 38900.00, 'used', 'Manual', 'Gasoline', 'Coupe', '["V8 455hp","Brembo Brakes","Performance Exhaust","Recaro Seats","Head-Up Display"]', 'available',
   'Thrilling 2023 Chevrolet Camaro LT1 in Red Hot. 6.2L V8 with 455 horsepower, 6-speed manual, Brembo brakes, and dual-mode performance exhaust.'),

  ('JTDKN3DU5A0000001', 'Toyota', 'Prius', 2024, 'XLE', 'Wind Chill Pearl', 'Black', 0, 33450.00, 'new', 'CVT', 'Hybrid', 'Sedan', '["Hybrid","AWD-e","Toyota Safety Sense 3.0","12.3-inch Display","Wireless Charging"]', 'available',
   'Ultra-efficient 2024 Toyota Prius XLE in Wind Chill Pearl. All-wheel drive hybrid with 57 MPG combined, the latest Safety Sense 3.0, and a gorgeous 12.3-inch display.'),

  ('3N1AB8CV0LY000001', 'Nissan', 'Rogue', 2024, 'SV', 'Super Black', 'Charcoal', 0, 32500.00, 'new', 'CVT', 'Gasoline', 'SUV', '["ProPILOT Assist","AWD","Divide-N-Hide Cargo","Panoramic Moonroof","Safety Shield 360"]', 'available',
   'Versatile 2024 Nissan Rogue SV in Super Black. All-wheel drive, ProPILOT Assist, panoramic moonroof, and the flexible Divide-N-Hide cargo system.'),

  ('1GKKNXLS0MZ000001', 'GMC', 'Sierra 1500', 2023, 'Denali', 'Onyx Black', 'Jet Black Leather', 16800, 55900.00, 'used', 'Automatic', 'Gasoline', 'Truck', '["4WD","Denali Ultimate","CarbonPro Bed","MultiPro Tailgate","Super Cruise"]', 'available',
   'Luxury truck: 2023 GMC Sierra 1500 Denali in Onyx Black. Full Denali Ultimate package, CarbonPro composite bed, and hands-free Super Cruise highway driving.'),

  ('WBAPH5C55BA000001', 'BMW', 'X3', 2024, 'xDrive30i', 'Phytonic Blue', 'Cognac', 200, 49800.00, 'new', 'Automatic', 'Gasoline', 'SUV', '["xDrive AWD","Panoramic Roof","Parking Assistant Pro","Live Cockpit","Harman Kardon"]', 'available',
   'Sporty 2024 BMW X3 xDrive30i in Phytonic Blue with cognac leather. Turbocharged, all-wheel drive, panoramic roof, and full parking assistant.'),

  ('KM8R3DHE5LU000001', 'Kia', 'Telluride', 2024, 'SX', 'Everlasting Silver', 'Navy', 0, 46200.00, 'new', 'Automatic', 'Gasoline', 'SUV', '["AWD","Captain Chairs","Harman Kardon","Head-Up Display","Highway Driving Assist 2"]', 'available',
   'Award-winning 2024 Kia Telluride SX in Everlasting Silver. Three-row seating with second-row captain chairs, premium Harman Kardon audio, and Highway Driving Assist 2.'),

  ('SALGS2RE3LA000001', 'Honda', 'CR-V', 2024, 'Sport Touring', 'Canyon River Blue', 'Black Leather', 0, 39750.00, 'new', 'CVT', 'Hybrid', 'SUV', '["Hybrid","AWD","Bose Audio","Wireless CarPlay","Honda Sensing 2.0","Heated/Ventilated Seats"]', 'available',
   'Efficient and capable: 2024 Honda CR-V Sport Touring Hybrid in Canyon River Blue. 40 MPG combined with AWD, Bose premium audio, and the latest Honda Sensing 2.0.')

ON CONFLICT (vin) DO NOTHING;


-- ════════════════════════════════════════════
-- KNOWLEDGE BASE (FAQ, policies, promos, financing)
-- ════════════════════════════════════════════

INSERT INTO knowledge_chunks (source, content, metadata)
VALUES
  -- ── Dealership info ──
  ('faq', 'Our dealership is open Monday through Saturday, 9 AM to 8 PM, and Sunday from 11 AM to 5 PM. We are closed on major holidays including New Year''s Day, Thanksgiving, and Christmas.', '{"topic":"hours"}'),
  ('faq', 'We are located at 1234 Auto Mall Drive, Springfield, IL 62701. We have ample free parking and are easily accessible from Interstate 55.', '{"topic":"location"}'),
  ('faq', 'You can reach our sales team at 555-AUTO-DEAL (555-288-6332) during business hours, or leave a message and we will call you back within one business day.', '{"topic":"contact"}'),

  -- ── Test drives ──
  ('faq', 'We offer complimentary test drives on all vehicles in our inventory. No appointment is necessary during business hours, but we recommend scheduling ahead for weekends. You must bring a valid driver''s license. Test drives typically last 15 to 20 minutes.', '{"topic":"test_drive"}'),

  -- ── Trade-ins ──
  ('faq', 'We accept trade-ins on all purchases. Bring your vehicle along with the title or payoff information and we will provide a competitive written offer on the spot. Our appraisal uses Kelley Blue Book and real-time auction data. Trade-in offers are valid for 7 days.', '{"topic":"trade_in"}'),

  -- ── Return policy ──
  ('policy', 'We offer a 5-day, 250-mile money-back guarantee on all used and certified pre-owned vehicles. If you are not completely satisfied, return the vehicle in the same condition and we will issue a full refund minus a $250 restocking fee. New vehicles are not eligible for the money-back guarantee but are covered under manufacturer warranty.', '{"topic":"returns"}'),

  -- ── Warranty ──
  ('policy', 'All new vehicles come with the full manufacturer warranty. Certified pre-owned vehicles include an extended powertrain warranty of 5 years or 100,000 miles from the original in-service date. Used vehicles are sold as-is unless you purchase our optional extended warranty, which covers major components for up to 3 years.', '{"topic":"warranty"}'),

  -- ── Financing ──
  ('financing', 'We work with over 20 lending partners to find the best rate for your situation. Most customers qualify for financing with APR starting as low as 2.9% for 60 months on new vehicles and 4.9% on pre-owned. We can pre-qualify you with a soft credit check that does not affect your credit score. Full approval requires a hard inquiry.', '{"topic":"rates"}'),
  ('financing', 'We accept all forms of payment: cash, personal check, cashier''s check, bank wire, and financing through our lending partners or your own bank. For purchases over $10,000 in cash, federal regulations require us to file a Currency Transaction Report. Down payments as low as $0 are available for qualified buyers.', '{"topic":"payment"}'),
  ('financing', 'Our lease specials change monthly. Current offers include 36-month leases on select models with $2,999 due at signing. Lease-end options include purchase at residual value, return, or trade up to a newer model. Mileage limits are typically 10,000 or 12,000 miles per year, with excess mileage charged at $0.20 per mile.', '{"topic":"leasing"}'),

  -- ── Service ──
  ('service', 'Our service department is open Monday through Friday, 7 AM to 6 PM, and Saturday from 8 AM to 2 PM. We service all makes and models, not just the brands we sell. Online appointment booking is available at our website. Oil changes start at $39.99 and include a complimentary multi-point inspection.', '{"topic":"service_hours"}'),
  ('service', 'We offer complimentary shuttle service within a 15-mile radius and loaner vehicles for repairs expected to take more than 4 hours. Our waiting area features free Wi-Fi, coffee, and a children''s play area.', '{"topic":"service_amenities"}'),

  -- ── Promotions ──
  ('promo', 'Spring Sale Event: Get up to $3,000 off MSRP on all 2024 models in stock, plus 0% APR for 48 months on select new Toyota, Honda, and Hyundai models. Offer valid through June 30th. Cannot be combined with other offers. See dealer for details.', '{"topic":"spring_sale"}'),
  ('promo', 'First Responder and Military Discount: We offer an additional $500 off any vehicle purchase for active military, veterans, police officers, firefighters, and EMTs. Bring valid ID or proof of service.', '{"topic":"military_discount"}'),
  ('promo', 'Referral Program: Refer a friend who purchases a vehicle and you both receive a $250 gift card. There is no limit on the number of referrals. Ask your sales representative for a referral card.', '{"topic":"referral"}')

ON CONFLICT DO NOTHING;
