// Layer 13A — importing a recipe from a website link against a scripted API
// (docs/30_API.md §33). The app sends the link, shows the server's draft for
// review and saves what the user reviewed through the import. Values are
// invented test data.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RecipeImportScreen } from '../src/features/recipes/RecipeImportScreen';
import { RecipesScreen } from '../src/features/recipes/RecipesScreen';
import { PROFILE_A, profileDto, profilePage } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const IMPORT = 'bbbbbbbb-1111-4000-8000-000000000001';
const RECIPE = 'bbbbbbbb-1111-4000-8000-0000000000r1';
const PATH = `/v1/profiles/${PROFILE_A}/recipe-imports`;
const LINK = 'https://www.kitchen.example.com/rice-bowl';
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

function imported(o: Partial<{ status: string; error_code: string | null; servings: number | null; yield_text: string | null; recipe_id: string | null; existing_recipe_id: string | null }> = {}) {
  const ok = (o.status ?? 'needs_confirmation') === 'needs_confirmation' || o.status === 'succeeded';
  return {
    id: IMPORT,
    status: o.status ?? 'needs_confirmation',
    error_code: o.error_code ?? null,
    source: { url: LINK, original_url: LINK, provider: 'web' },
    draft: ok
      ? {
          title: 'Rice Bowl',
          description: 'Quick.',
          servings: o.servings === undefined ? 4 : o.servings,
          yield_text: o.yield_text ?? null,
          ingredients: [
            { text: '200 g cooked rice', quantity: 200, unit: 'g' },
            { text: '2 cups spinach', note: 'ambiguous_unit' },
            { text: '1 egg', quantity: 1 },
          ],
          instructions: ['Cook.', 'Serve.'],
          truncated: false,
        }
      : null,
    recipe_id: o.recipe_id ?? null,
    existing_recipe_id: o.existing_recipe_id ?? null,
  };
}

const savedRecipe = {
  id: RECIPE,
  title: 'Rice Bowl',
  updated_at: '2026-10-31T00:00:00Z',
  version_count: 1,
  current_version: { id: 'v1', version_number: 1, is_current: true, title: 'Rice Bowl', description: 'Quick.', servings: 4, ingredients: [], instructions: [] },
};

describe('Import from a link', () => {
  it('is offered only to scopes that can manage recipes', async () => {
    await renderApp(<RecipesScreen onOpen={jest.fn()} onNew={jest.fn()} onImport={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles('view_only'),
        [`GET /v1/profiles/${PROFILE_A}/recipes`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
      },
    });
    await screen.findByTestId('recipes-empty');
    expect(screen.queryByTestId('import-recipe')).toBeNull();
  });

  it('sends the link, shows the draft for review and saves what was reviewed', async () => {
    const started: Call[] = [];
    const saved: Call[] = [];
    const onSaved = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={onSaved} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: (call) => {
          started.push(call);
          return json(201, imported());
        },
        [`POST ${PATH}/${IMPORT}/save`]: (call) => {
          saved.push(call);
          return json(201, savedRecipe);
        },
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), `  ${LINK} `);
    await fireEvent.press(screen.getByTestId('import-submit'));

    expect(await screen.findByTestId('import-source')).toHaveTextContent('From kitchen.example.com');
    expect(started[0]!.body).toEqual({ url: LINK, idempotency_key: expect.stringMatching(/^import-[a-z0-9-]+$/) });
    expect(screen.getByTestId('recipe-title').props.value).toBe('Rice Bowl');
    expect(screen.getByTestId('recipe-servings-input').props.value).toBe('4');
    // Nothing is linked to a food; the cup line has no amount.
    expect(screen.getByTestId('draft-ingredient-status-1')).toHaveTextContent('Text only, not counted in nutrition');

    await fireEvent.changeText(screen.getByTestId('recipe-title'), 'My Rice Bowl');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(RECIPE));
    expect(saved[0]!.body).toEqual({
      title: 'My Rice Bowl',
      description: 'Quick.',
      servings: 4,
      ingredients: [{ text: '200 g cooked rice', quantity: 200, unit: 'g' }, { text: '2 cups spinach' }, { text: '1 egg', quantity: 1 }],
      instructions: ['Cook.', 'Serve.'],
    });
  });

  it('asks for servings when the page gives none', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ servings: null, yield_text: 'Makes 24 cookies' })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-yield')).toHaveTextContent(/The page says: “Makes 24 cookies”/);
    expect(screen.getByTestId('recipe-servings-input').props.value).toBe('');
  });

  it('explains a page without recipe data and lets the user try another link', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ status: 'permanently_failed', error_code: 'no_recipe_found' })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-failed')).toHaveTextContent(/does not publish recipe details/);
    await fireEvent.press(screen.getByTestId('import-try-again'));
    expect(await screen.findByTestId('import-url')).toBeTruthy();
  });

  it('shows a refused link (e.g. Instagram) without the server wording', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(400, { error: { code: 'VALIDATION_ERROR', message: 'server text', details: { issues: [{ path: 'url', message: 'unsupported_provider' }] }, requestId: 'r' } }),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), 'https://www.instagram.com/p/abc/');
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent(/Instagram, TikTok and YouTube are not supported yet/);
    expect(screen.queryByText('server text')).toBeNull();
  });

  it('points to the recipe already imported from the same link', async () => {
    const onOpen = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ existing_recipe_id: RECIPE })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    await fireEvent.press(await screen.findByTestId('import-open-existing'));
    expect(onOpen).toHaveBeenCalledWith(RECIPE);
    expect(screen.queryByTestId('recipe-save')).toBeNull();
  });

  it('a save refused because it was saved meanwhile switches to the saved recipe', async () => {
    const onOpen = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported()),
        [`POST ${PATH}/${IMPORT}/save`]: () => json(409, { error: { code: 'CONFLICT', message: 'x', requestId: 'r' } }),
        [`GET ${PATH}/${IMPORT}`]: () => json(200, imported({ status: 'succeeded', recipe_id: RECIPE, existing_recipe_id: RECIPE })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    await fireEvent.press(await screen.findByTestId('recipe-save'));
    await fireEvent.press(await screen.findByTestId('import-open-existing'));
    expect(onOpen).toHaveBeenCalledWith(RECIPE);
  });
});
