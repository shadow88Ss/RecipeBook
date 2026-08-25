# Entity Relationships

> **Superseded by `29_Data_Model.md`.** Retained verbatim as historical source material. `29_Data_Model.md` §6, §7, §11, §13–14 add the relationships involving `RecipePersonalizedVariant`, `ImportJob`, `EffectiveTargetSnapshot`, and `GuardianAuthorization` that this fragment predates.

Key relationships:
- Account 1..N Profiles
- Account 1..N AuthIdentities
- Profile 1..N MealLogs
- Recipe N..N Profiles through preference/rating tables
- Recipe 1..N Ingredients
- Recipe 1..N Versions
- Profile 1..N Goals/Targets
- Profile 1..N WearableConnections
- UrlSource 1..N RawContent
- RawContent 1..N AiExtractions
