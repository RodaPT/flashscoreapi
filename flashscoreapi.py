import datetime
import requests
import json
import os.path
from bs4 import BeautifulSoup
from google.oauth2 import service_account
import googleapiclient.discovery

def scrape_matches(urls):
    """
    Scrape upcoming match information from the provided URLs.
    
    Args:
    - urls (list): A list of URLs containing match information.
    
    Returns:
    - A list of dictionaries, with each dictionary representing an upcoming match and containing keys for team names, date and time, location, and match link.
    """
    match_info_list = []

    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
        }

        for url in urls:
            # Send a GET request to the webpage
            response = requests.get(url, headers=headers)
            response.raise_for_status()  # Raise an exception for bad status codes

            # Parse the HTML content of the response
            soup = BeautifulSoup(response.content, 'html.parser')

            # Find the match panels
            match_panels = soup.find_all('div', class_='panel')

            # Extract match information from each panel
            for panel in match_panels:
                matches = panel.find_all('a', class_='match-link')
                for match in matches:
                    # Check the match tag
                    match_tag = match.find('span', class_='tag')
                    if match_tag:
                        match_status = match_tag.get_text(strip=True)
                        if match_status == 'Fim':
                            continue  # Skip matches that are already finished

                    # Extract team names
                    teams = match.find_all('div', class_='name')
                    team1 = teams[0].get_text(strip=True)
                    team2 = teams[1].get_text(strip=True)

                    # Extract date and time
                    datetime_str = match['starttime']
                    datetime_obj = datetime.datetime.strptime(datetime_str, '%Y-%m-%dT%H:%M:%S%z')

                    # Extract match link
                    match_link = match['href']
                    
                    match_info_list.append({
                        'team1': team1,
                        'team2': team2,
                        'datetime': datetime_obj,
                        'match_link': match_link
                    })

    except requests.RequestException as e:
        print("Error fetching webpage:", e)
    except Exception as e:
        print("An error occurred:", e)

    return match_info_list


# Function to add events to Google Calendar
def add_events_to_calendar(matches):
    credentials = service_account.Credentials.from_service_account_file(
        'service-account.json',
        scopes=['https://www.googleapis.com/auth/calendar']
    )
    service = googleapiclient.discovery.build('calendar', 'v3', credentials=credentials)
    calendar_id = '870d419d0d043e060fe24a8560fa7dbc119712122d907ad7867f8fd41d5beff2@group.calendar.google.com'  # Use 'primary' for the primary calendar

    # Check if the event_ids file exists
    if os.path.exists('event_ids.json'):
        # Load existing event IDs from the file
        with open('event_ids.json', 'r') as file:
            try:
                event_ids = json.load(file)
            except json.decoder.JSONDecodeError:
                event_ids = {}
    else:
        # If the file doesn't exist, initialize an empty dictionary
        event_ids = {}

    # Iterate through the matches
    for match in matches:
        # Check if the match link exists in the event IDs dictionary
        if match['match_link'] in event_ids:
            # If the event already exists, update it
            event_id = event_ids[match['match_link']]
            event = {
                'summary': f"{match['team1']} vs {match['team2']}",
                'start': {
                    'dateTime': match['datetime'].isoformat(),
                    'timeZone': 'Europe/Lisbon',
                },
                'end': {
                    'dateTime': (match['datetime'] + datetime.timedelta(hours=2)).isoformat(),
                    'timeZone': 'Europe/Lisbon',
                },
            }
            # Update the event
            updated_event = service.events().update(calendarId=calendar_id, eventId=event_id, body=event).execute()
        else:
            # If the event does not exist, create it
            event = {
                'summary': f"{match['team1']} vs {match['team2']}",
                'start': {
                    'dateTime': match['datetime'].isoformat(),
                    'timeZone': 'Europe/Lisbon',
                },
                'end': {
                    'dateTime': (match['datetime'] + datetime.timedelta(hours=2)).isoformat(),
                    'timeZone': 'Europe/Lisbon',
                },
            }
            # Insert the event and retrieve the event ID
            event_result = service.events().insert(calendarId=calendar_id, body=event).execute()
            # Add the event ID to the event IDs dictionary
            event_ids[match['match_link']] = event_result['id']

    # Save the updated event IDs to the file
    with open('event_ids.json', 'w') as file:
        json.dump(event_ids, file)



def main():
    # URLs of the webpages containing the upcoming match information
    urls = [
        "https://pt.besoccer.com/time/jogos/sporting-lisbon",
        "https://pt.besoccer.com/time/jogos/uniao-leiria",
        "https://pt.besoccer.com/time/jogos/seleccion-portugal",
        "https://pt.besoccer.com/time/jogos/manchester-united-fc"
    ]

    # Scrape upcoming match information
    upcoming_matches = scrape_matches(urls)

    # Print upcoming matches
    if upcoming_matches:
        for match in upcoming_matches:
            print("Team 1:", match['team1'])
            print("Team 2:", match['team2'])
            print("Date and Time:", match['datetime'])
            print()
    else:
        print("No upcoming matches found.")

    # Add or update events in Google Calendar
    add_events_to_calendar(upcoming_matches)


if __name__ == "__main__":
    main()


#870d419d0d043e060fe24a8560fa7dbc119712122d907ad7867f8fd41d5beff2@group.calendar.google.com
