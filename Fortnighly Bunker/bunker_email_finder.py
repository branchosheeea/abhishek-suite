import win32com.client

outlook = win32com.client.Dispatch("Outlook.Application")
namespace = outlook.GetNamespace("MAPI")

inbox = namespace.GetDefaultFolder(6)

messages = inbox.Items
messages.Sort("[ReceivedTime]", True)

count = 0

for message in messages:

    try:

        if "Fortnightly" in str(message.Subject):

            print("=" * 60)
            print("SUBJECT:", message.Subject)
            print("ATTACHMENTS:", message.Attachments.Count)

            for i in range(1, message.Attachments.Count + 1):

                attachment = message.Attachments.Item(i)

                print("  FILE:", attachment.FileName)

            count += 1

            if count >= 10:
                break

    except:
        pass