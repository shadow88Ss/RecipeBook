// Layer 12D — edit one ingredient line: the text as written, and optionally a
// Food the user picks from the server's search (a confirmed match) with an
// amount in a unit or one of that Food's servings. A line without a Food is
// kept as text only and is not counted in nutrition; nothing is matched
// automatically.

import { useState } from 'react';
import { View } from 'react-native';

import { t } from '../../i18n';
import { Button, Card, Input, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { FoodAmountFields, FoodSearch, useFoodAmount } from '../food/FoodAmount';
import { foodName } from '../log/LogScreen';
import type { DraftIngredient } from './draft';

export function IngredientEditor({ initial, onSave, onCancel }: { initial: DraftIngredient; onSave: (next: DraftIngredient) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial.text);
  const [food, setFood] = useState(initial.food);
  const [touched, setTouched] = useState(false);
  const amountState = useFoodAmount(food?.id ?? null, initial.amount);
  const { amount, detail } = amountState;

  const textMissing = !text.trim();
  const amountMissing = !!food && !amount;
  const save = () => {
    setTouched(true);
    if (textMissing || amountMissing) return;
    // Without a Food, a stored amount is kept for the record (never calculated).
    const nextAmount = food ? amount : initial.food ? null : initial.amount;
    onSave({ ...initial, text: text.trim(), food, amount: nextAmount, unconfirmedSuggestion: food ? false : initial.unconfirmedSuggestion });
  };

  return (
    <Card testID="ingredient-editor">
      <Input label={t('recipeEdit.ingredientText')} value={text} onChangeText={setText} maxLength={500} testID="ingredient-text" />
      {touched && textMissing ? <Text variant="error">{t('recipeEdit.error.ingredientText')}</Text> : null}
      {food ? (
        <View style={{ gap: theme.space.sm }}>
          <Text testID="linked-food">{t('recipeEdit.linkedTo', { name: food.name ?? (detail.data ? foodName(detail.data) : t('recipeEdit.aFood')) })}</Text>
          <Button
            label={t('recipeEdit.unlink')}
            variant="secondary"
            onPress={() => {
              setFood(null);
              amountState.reset();
            }}
            testID="unlink-food"
          />
          <FoodAmountFields state={amountState} showMissing={touched} />
        </View>
      ) : (
        <View style={{ gap: theme.space.sm }}>
          <Text variant="small">{initial.unconfirmedSuggestion ? t('recipeEdit.unconfirmedHint') : t('recipeEdit.textOnlyHint')}</Text>
          <FoodSearch
            label={t('recipeEdit.findFood')}
            onPick={(picked) => {
              setFood(picked);
              amountState.reset();
            }}
          />
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button label={t('recipeEdit.saveLine')} onPress={save} testID="ingredient-save" />
        <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={onCancel} testID="ingredient-cancel" />
      </View>
    </Card>
  );
}
