# AI Nutrition Platform — Claude Development Workspace

## Purpose
This workspace is the master specification for a cross-platform AI nutrition application for iOS and Android.

The platform supports:
- Multimodal meal logging: voice, text, photo, URL, barcode, QR, manual entry.
- Universal food matching and measurement conversion.
- Deterministic calorie, macro, fiber, vitamin and mineral calculations.
- Persistent Recipe Library with search, tags, ratings, favorites and personalized variants.
- URL content ingestion from accessible Instagram, TikTok, YouTube and website sources.
- WHOOP, Apple HealthKit and Android Health Connect integrations.
- Adaptive nutrition and activity coaching for weight loss, maintenance and weight gain.
- Menstrual-cycle, pregnancy, postpartum and breastfeeding context.
- Multi-profile family accounts.
- Child nutrition and pediatric obesity-management support with dedicated safeguards.
- Google, Apple and email/password login with device biometrics.

## Architecture Principles
1. Claude interprets and reasons; deterministic services calculate.
2. Nutrient reference values come from trusted food/product data sources.
3. Every inferred value must store source, method and confidence.
4. Raw imported content must remain separate from normalized AI output.
5. Consumed meals are historical truth and are never retroactively optimized.
6. Planned meals may be optimized to fit current targets.
7. Clinician-defined targets override profile-derived and user-defined defaults.
8. Child recommendations use pediatric rules, never adult dieting logic.
9. Health/life-stage information is opt-in, permissioned, encrypted and deletable.
10. All modules expose APIs, failure behavior and acceptance criteria.

## Workspace Map
- 00_Master
- 01_User_Profile
- 02_Nutrition_Targets
- 03_Multimodal_Food_Logging
- 04_Universal_Food_Intelligence
- 05_Universal_Conversion_Engine
- 06_Nutrition_Database
- 07_Nutrition_Calculation
- 08_URL_Content_Ingestion
- 09_Recipe_Intelligence
- 10_Recipe_Library
- 11_Barcode_and_QR
- 12_Daily_Tracker
- 13_Adaptive_Nutrition_Coach
- 14_Activity_and_Energy_Coach
- 15_Wearable_Integrations
- 16_Micronutrient_Intelligence
- 17_Fiber_Intelligence
- 18_Womens_Nutrition_Intelligence
- 19_Family_and_Multi_Profile
- 20_Child_Nutrition
- 21_Pediatric_Weight_Management
- 22_Mobile_Application
- 23_Analytics_and_Insights
- 24_Dashboard
- 25_Search_and_AI_Query
- 26_Meal_Planning
- 27_Preferences_and_Personalization
- 28_Notifications
- 29_Data_Model
- 30_API
- 31_Claude_AI_Agents
- 32_AI_Confidence_and_Explainability
- 33_Security_and_Privacy
- 34_Clinical_and_Nutrition_Safety
- 35_Testing_and_Quality
- 36_Acceptance_Criteria
- 37_Authentication_and_Login
