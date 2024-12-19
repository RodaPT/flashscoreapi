import requests

# URL of the webpage containing the match information
url = "https://www.flashscore.pt/equipa/sporting-cp/tljXuHBC/lista/"

try:
    # Send a GET request to the webpage
    response = requests.get(url)
    response.raise_for_status()  # Raise an exception for bad status codes

    # Print the HTML content of the response
    print(response.text)

except requests.RequestException as e:
    print("Error fetching webpage:", e)
except Exception as e:
    print("An error occurred:", e)
