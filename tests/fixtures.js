// Minimal stand-ins for IMDb title pages. Each carries only the signals
// getContentDetails actually reads, in the shapes IMDb emits them.

function page({ jsonLd, ogType, titleType, extra = '', title = 'Some Title' }) {
  const ld = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    : '';
  const og = ogType ? `<meta property="og:type" content="${ogType}"/>` : '';
  // IMDb ships a large embedded GraphQL payload; this is the slice we read.
  let next = '';
  if (titleType) {
    const payload = {
      props: {
        pageProps: {
          aboveTheFoldData: {
            titleType: {
              __typename: 'TitleType',
              id: titleType,
              canHaveEpisodes: titleType.startsWith('tv') && titleType !== 'tvMovie'
            }
          }
        }
      }
    };
    next = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  }
  return `<!DOCTYPE html><html><head><title data-rh="true">${title} - IMDb</title>${og}${ld}${next}</head><body>${extra}</body></html>`;
}

const movie = page({
  title: 'The Shawshank Redemption',
  ogType: 'video.movie',
  titleType: 'movie',
  jsonLd: {
    '@type': 'Movie', name: 'The Shawshank Redemption',
    datePublished: '1994-10-14', genre: ['Drama'],
    aggregateRating: { ratingValue: 9.3, ratingCount: 2900000 },
    duration: 'PT2H22M'
  }
});

const series = page({
  title: 'Breaking Bad',
  ogType: 'video.tv_show',
  titleType: 'tvSeries',
  jsonLd: { '@type': 'TVSeries', name: 'Breaking Bad', datePublished: '2008-01-20', genre: ['Crime', 'Drama'] }
});

// The case that used to render as a movie in the popup.
const miniSeries = page({
  title: 'Chernobyl',
  ogType: 'video.tv_show',
  titleType: 'tvMiniSeries',
  jsonLd: { '@type': 'TVMiniSeries', name: 'Chernobyl', datePublished: '2019-05-06', genre: ['Drama', 'History'] }
});

const animeSeries = page({
  title: 'Shingeki no Kyojin',
  ogType: 'video.tv_show',
  titleType: 'tvSeries',
  jsonLd: { '@type': 'TVSeries', name: 'Shingeki no Kyojin', datePublished: '2013-04-07', genre: ['Animation', 'Action'] }
});

const animeMovie = page({
  title: 'Kimi no Na wa.',
  ogType: 'video.movie',
  titleType: 'movie',
  jsonLd: { '@type': 'Movie', name: 'Kimi no Na wa.', datePublished: '2016-08-26', genre: ['Animation', 'Drama'] }
});

const episode = page({
  title: 'Breaking Bad: Ozymandias',
  ogType: 'video.episode',
  titleType: 'tvEpisode',
  jsonLd: {
    '@type': 'TVEpisode', name: 'Ozymandias',
    partOfSeries: { '@type': 'TVSeries', name: 'Breaking Bad', url: '/title/tt0903747/' },
    partOfSeason: { '@type': 'TVSeason', seasonNumber: 5 },
    episodeNumber: 14
  }
});

// JSON-LD dropped entirely — the failure mode where everything became a movie.
const seriesNoJsonLd = page({ title: 'Breaking Bad', ogType: 'video.tv_show', titleType: 'tvSeries' });
const miniSeriesOnlyTitleType = page({ title: 'Chernobyl', titleType: 'tvMiniSeries' });
const seriesOnlyEpisodeHint = page({
  title: 'Some Show',
  extra: '<script>window.__d={"canHaveEpisodes":true}</script>'
});

// JSON-LD present but generic; the page still says series.
const seriesGenericJsonLd = page({
  title: 'Some Show',
  ogType: 'video.tv_show',
  titleType: 'tvSeries',
  jsonLd: { '@type': 'CreativeWork', name: 'Some Show' }
});

const seriesArrayType = page({
  title: 'Some Show',
  ogType: 'video.tv_show',
  jsonLd: { '@type': ['CreativeWork', 'TVSeries'], name: 'Some Show' }
});

// Episode page whose JSON-LD lacks partOfSeries.
const episodeNoParentInJsonLd = page({
  title: 'Ozymandias',
  ogType: 'video.episode',
  titleType: 'tvEpisode',
  jsonLd: { '@type': 'TVEpisode', name: 'Ozymandias', episodeNumber: 14 },
  extra: '<script>window.__d={"series":{"__typename":"Title","id":"tt0903747"}}</script>'
});

module.exports = {
  page, movie, series, miniSeries, animeSeries, animeMovie, episode,
  seriesNoJsonLd, miniSeriesOnlyTitleType, seriesOnlyEpisodeHint,
  seriesGenericJsonLd, seriesArrayType, episodeNoParentInJsonLd
};

// A row as the suggestion API returns it (shape confirmed against the live
// endpoint for tt0944947).
function suggestionRow({ id, qid, title = 'Some Title', year = 2011, poster = null }) {
  const row = { id, l: title, q: qid, qid, y: year, rank: 27 };
  if (poster) row.i = { imageUrl: poster, height: 1090, width: 736 };
  return row;
}

module.exports.suggestionRow = suggestionRow;
module.exports.gotSuggestion = suggestionRow({
  id: 'tt0944947', qid: 'tvSeries', title: 'Game of Thrones', year: 2011,
  poster: 'https://m.media-amazon.com/images/M/got.jpg'
});
