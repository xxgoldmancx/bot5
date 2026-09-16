type WeatherResult = {
  location: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  precipitation: number;
  windSpeed: number;
  weatherCode: number;
  timezone: string;
};

const weatherDescriptions: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Heavy rain showers",
  95: "Thunderstorms",
  96: "Thunderstorms with hail",
  99: "Thunderstorms with heavy hail",
};

function isWeatherRequest(message: string) {
  return /\b(weather|forecast|temperature|raining|rain|snowing|snow)\b/i.test(
    message,
  );
}

function extractLocation(message: string) {
  const match = message.match(
    /\b(?:weather|forecast|temperature|raining|rain|snowing|snow)\b(?:\s+(?:like\s+)?(?:in|for|at|near))?\s+(.+?)(?:\?|$)/i,
  );
  const location = match?.[1]
    ?.replace(/\b(right now|today|currently|please)\b/gi, "")
    .replace(/[,.!?]+$/, "")
    .trim();
  return location || null;
}

function locationLabel(result: {
  name: string;
  admin1?: string;
  country?: string;
}) {
  return [result.name, result.admin1, result.country]
    .filter(Boolean)
    .join(", ");
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Weather service returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchWeather(location: string): Promise<WeatherResult> {
  const geocodeUrl = new URL(
    "https://geocoding-api.open-meteo.com/v1/search",
  );
  geocodeUrl.search = new URLSearchParams({
    name: location,
    count: "1",
    language: "en",
    format: "json",
  }).toString();
  const geocode = await fetchJson<{
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      admin1?: string;
      country?: string;
    }>;
  }>(geocodeUrl);
  const place = geocode.results?.[0];
  if (!place) throw new Error(`Could not find a location for ${location}`);

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
  }).toString();
  const forecast = await fetchJson<{
    current?: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      precipitation: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    timezone: string;
  }>(forecastUrl);
  if (!forecast.current) throw new Error("Weather response had no current data");

  return {
    location: locationLabel(place),
    temperature: forecast.current.temperature_2m,
    feelsLike: forecast.current.apparent_temperature,
    humidity: forecast.current.relative_humidity_2m,
    precipitation: forecast.current.precipitation,
    windSpeed: forecast.current.wind_speed_10m,
    weatherCode: forecast.current.weather_code,
    timezone: forecast.timezone,
  };
}

export function isLiveWeatherRequest(message: string) {
  return isWeatherRequest(message);
}

export async function buildWeatherResponse(message: string) {
  const location = extractLocation(message);
  if (!location) {
    return "Tell me a location for the live weather lookup, for example: `!task weather in Boston`.";
  }

  try {
    const weather = await fetchWeather(location);
    const condition =
      weatherDescriptions[weather.weatherCode] ?? "Current conditions";
    return [
      `Weather for ${weather.location}`,
      `${weather.temperature}°F, feels like ${weather.feelsLike}°F — ${condition}.`,
      `Humidity: ${weather.humidity}% · Wind: ${weather.windSpeed} mph · Precipitation: ${weather.precipitation} mm.`,
      `Local timezone: ${weather.timezone}.`,
    ].join("\n");
  } catch {
    return `I couldn't get live weather for "${location}" right now. Try a city and country, such as \`!task weather in London, UK\`.`;
  }
}