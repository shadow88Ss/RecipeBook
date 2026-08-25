# Database Schema

> **Superseded by `29_Data_Model.md`.** Retained verbatim as historical source material — no contradiction with `00_Master.md` was found in this fragment itself; the gaps identified (meal lifecycle state, effective-target provenance, personalized recipe variants, import idempotency, wearable provenance, AI confidence fields, locale fields, guardian authorization) are additive and are addressed in `29_Data_Model.md`.

Core entities:
- Account
- AuthIdentity
- DeviceSession
- Profile
- ChildProfileExtension
- Goal
- NutritionTarget
- ClinicianTarget
- WeightMeasurement
- Food
- FoodAlias
- FoodServing
- Nutrient
- FoodNutrient
- Product
- Barcode
- MealLog
- MealItem
- Recipe
- RecipeIngredient
- RecipeInstruction
- RecipeCategory
- RecipeTag
- RecipeRating
- RecipeVersion
- UrlSource
- RawContent
- AiExtraction
- WearableConnection
- Activity
- Workout
- Sleep
- Recovery
- CycleRecord
- PregnancyProfile
- PostpartumProfile
- BreastfeedingProfile
- CoachRecommendation
- NotificationPreference
- AuditEvent
