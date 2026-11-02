@capability:error-mapping
Feature: Drive failures reach the client as HTTP statuses

  @id:a-drive-server-error-reaches-the-user-as-a-bad-gateway
  Scenario: A Drive server error reaches the user as a bad gateway
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the Drive answers the next listing of "Photos" with a server error
    When the user lists "Photos"
    Then the listing fails as a bad gateway

  @id:a-file-that-fails-verification-reaches-the-user-as-a-bad-gateway
  Scenario: A file that fails its integrity check reaches the user as a bad gateway
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the file "Photos/beach.jpg" fails its integrity check
    When the user reads "Photos/beach.jpg"
    Then the read fails as a bad gateway saying the data failed verification

  @id:an-unreachable-drive-reaches-the-user-as-unavailable
  Scenario: A Drive out of reach reaches the user as unavailable
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the Drive cannot be reached for the next listing of "Photos"
    When the user lists "Photos"
    Then the listing fails as unavailable, to retry after 10 seconds

  @id:a-name-clash-on-upload-reaches-the-user-as-a-conflict
  Scenario: A name clash on an upload reaches the user as a conflict
    Given a Drive whose My files holds the folder "Photos"
    And the Drive refuses the next upload into "Photos" because the name exists
    When the user writes "sand and sea" to "Photos/beach.jpg"
    Then the write fails as a conflict
